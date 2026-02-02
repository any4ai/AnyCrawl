import { log } from "crawlee";
import { getDB, schemas, eq, sql } from "@anycrawl/db";
import { QueueManager } from "./Queue.js";
import { randomUUID } from "crypto";
import { Job, Queue } from "bullmq";
import IORedis from "ioredis";
import { WebhookEventType, estimateTaskCredits, isScheduledTasksLimitEnabled, getScheduledTasksLimit, buildAutoPauseReason } from "@anycrawl/libs";
import { CronExpressionParser } from "cron-parser";

/**
 * SchedulerManager using BullMQ Repeatable Jobs
 *
 * Architecture:
 * 1. All scheduled tasks are added as BullMQ repeatable jobs to a dedicated "scheduler" queue
 * 2. When a repeatable job triggers, the worker executes the scheduling logic (checks, limits)
 * 3. If all checks pass, the actual scrape/crawl job is added to the appropriate queue
 * 4. BullMQ handles all the cron scheduling, persistence, and distribution automatically
 */
export class SchedulerManager {
    private static instance: SchedulerManager;
    private isRunning: boolean = false;
    private schedulerQueue: Queue | null = null;
    private redis: IORedis.Redis | null = null;
    private readonly SCHEDULER_QUEUE_NAME = "scheduler";
    private syncInterval: NodeJS.Timeout | null = null;
    private lastSyncTime: Date = new Date();
    private readonly SYNC_INTERVAL_MS: number;
    private readonly POLL_LOCK_KEY = "scheduler:poll:lock";

    private constructor() {
        // Default to 10 seconds, configurable via environment variable
        this.SYNC_INTERVAL_MS = parseInt(process.env.ANYCRAWL_SCHEDULER_SYNC_INTERVAL_MS || "10000");
    }

    public static getInstance(): SchedulerManager {
        if (!SchedulerManager.instance) {
            SchedulerManager.instance = new SchedulerManager();
        }
        return SchedulerManager.instance;
    }

    public async start(): Promise<void> {
        if (this.isRunning) {
            log.warning("[SCHEDULER] Scheduler is already running");
            return;
        }

        this.isRunning = true;
        log.info("[SCHEDULER] 🕒 Starting Scheduler Manager (BullMQ)...");

        // Initialize shared Redis connection for distributed locking
        this.redis = new IORedis.default(process.env.ANYCRAWL_REDIS_URL!, {
            maxRetriesPerRequest: null,
        });

        // Get or create the scheduler queue
        const queueManager = QueueManager.getInstance();
        this.schedulerQueue = queueManager.getQueue(this.SCHEDULER_QUEUE_NAME);

        // Initial sync: Sync all database tasks to BullMQ
        await this.syncScheduledTasks();
        this.lastSyncTime = new Date();

        // Start periodic polling to detect new/updated tasks
        this.startPolling();

        log.info(`[SCHEDULER] ✅ Scheduler Manager started successfully (polling every ${this.SYNC_INTERVAL_MS / 1000}s)`);
    }

    /**
     * Sync all active scheduled tasks from database to BullMQ repeatable jobs
     * This ensures tasks are registered as repeatable jobs
     */
    public async syncScheduledTasks(): Promise<void> {
        try {
            const db = await getDB();

            // Get all active and non-paused tasks
            const activeTasks = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(sql`${schemas.scheduledTasks.isActive} = true AND ${schemas.scheduledTasks.isPaused} = false`);

            log.info(`[SCHEDULER] Syncing ${activeTasks.length} active tasks to BullMQ`);

            // First, remove ALL existing job schedulers to ensure clean state
            // This handles paused/deleted tasks that may still have schedulers
            await this.removeAllJobSchedulers();

            // Add only active tasks
            for (const task of activeTasks) {
                await this.addScheduledTask(task);
            }

            log.info(`[SCHEDULER] ✅ Synced ${activeTasks.length} tasks to BullMQ`);
        } catch (error) {
            log.error(`[SCHEDULER] Error syncing scheduled tasks: ${error}`);
        }
    }

    /**
     * Remove all job schedulers from the queue
     * Used during sync to ensure clean state
     */
    private async removeAllJobSchedulers(): Promise<void> {
        if (!this.schedulerQueue) {
            return;
        }

        try {
            const jobSchedulers = await this.schedulerQueue.getJobSchedulers();
            log.debug(`[SCHEDULER] Removing ${jobSchedulers.length} existing job schedulers`);

            for (const scheduler of jobSchedulers) {
                await this.schedulerQueue.removeJobScheduler(scheduler.key);
            }

            log.debug(`[SCHEDULER] Removed all job schedulers`);
        } catch (error) {
            log.error(`[SCHEDULER] Failed to remove all job schedulers: ${error}`);
        }
    }

    /**
     * Check if the scheduler is running
     */
    public isSchedulerRunning(): boolean {
        return this.isRunning && this.schedulerQueue !== null;
    }

    /**
     * Add or update a scheduled task as a BullMQ repeatable job
     */
    public async addScheduledTask(task: any): Promise<void> {
        if (!this.schedulerQueue) {
            throw new Error("Scheduler queue not initialized. Make sure to call start() first or set ANYCRAWL_SCHEDULER_ENABLED=true");
        }

        try {
            // Add as repeatable job
            await this.schedulerQueue.add(
                'scheduled-task',
                {
                    taskUuid: task.uuid,
                    taskName: task.name,
                    taskType: task.taskType,
                    taskPayload: task.taskPayload,
                },
                {
                    jobId: `scheduled:${task.uuid}`,
                    repeat: {
                        pattern: task.cronExpression,
                        tz: task.timezone || "UTC",
                    },
                    removeOnComplete: 100, // Keep last 100 completed jobs for debugging
                    removeOnFail: 100,
                }
            );

            log.info(`[SCHEDULER] 📅 Scheduled task: ${task.name} (${task.cronExpression}) [${task.timezone}]`);
        } catch (error) {
            log.error(`[SCHEDULER] Failed to add scheduled task ${task.name}: ${error}`);
            throw error;
        }
    }

    /**
     * Remove a scheduled task from BullMQ repeatable jobs
     * Note: This is a best-effort removal. Full cleanup happens in syncScheduledTasks.
     */
    public async removeScheduledTask(taskUuid: string): Promise<void> {
        if (!this.schedulerQueue) {
            return;
        }

        try {
            // Get all job schedulers and find the one for this task
            const jobSchedulers = await this.schedulerQueue.getJobSchedulers();

            for (const scheduler of jobSchedulers) {
                // Get the next job for this scheduler to check its data
                const nextJob = await this.schedulerQueue.getJob(`repeat:${scheduler.key}`);
                if (nextJob?.data?.taskUuid === taskUuid) {
                    await this.schedulerQueue.removeJobScheduler(scheduler.key);
                    log.debug(`[SCHEDULER] Removed job scheduler for task ${taskUuid}`);
                    return;
                }
            }

            log.debug(`[SCHEDULER] No scheduler found for task: ${taskUuid}`);
        } catch (error) {
            log.error(`[SCHEDULER] Failed to remove scheduled task ${taskUuid}: ${error}`);
        }
    }

    /**
     * Process a scheduled task job (called by the worker)
     * This is where the actual scheduling logic happens
     */
    public async processScheduledTaskJob(job: Job): Promise<void> {
        const { taskUuid } = job.data;
        const db = await getDB();
        let executionUuid: string | undefined;

        try {
            // Fetch the latest task configuration
            const tasks = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(eq(schemas.scheduledTasks.uuid, taskUuid))
                .limit(1);

            if (!tasks.length) {
                log.warning(`[SCHEDULER] Task ${taskUuid} not found in database, skipping`);
                return;
            }

            const task = tasks[0];

            // Check if task is still active
            if (!task.isActive) {
                log.info(`[SCHEDULER] Task ${task.name} is no longer active, skipping`);
                return;
            }

            // Check if task is paused
            if (task.isPaused) {
                log.info(`[SCHEDULER] Task ${task.name} is paused, skipping execution`);
                return;
            }

            // Check credits using dynamic estimation
            // Only check if ANYCRAWL_API_CREDITS_ENABLED is true
            const creditsEnabled = process.env.ANYCRAWL_API_CREDITS_ENABLED === "true";
            if (creditsEnabled) {
                // Dynamically calculate required credits, use the larger of stored value and real-time estimate
                let estimatedCredits = 0;

                // If task has a template, fetch it for accurate credit estimation
                if (task.taskPayload?.template_id) {
                    try {
                        const { getTemplate } = await import("@anycrawl/db");
                        const template = await getTemplate(task.taskPayload.template_id);
                        if (template) {
                            estimatedCredits = estimateTaskCredits(
                                template.templateType || task.taskType,
                                task.taskPayload,
                                { template }
                            );
                        } else {
                            estimatedCredits = estimateTaskCredits(task.taskType, task.taskPayload);
                        }
                    } catch (e) {
                        log.warning(`[SCHEDULER] Failed to fetch template for credit estimation: ${e}`);
                        estimatedCredits = estimateTaskCredits(task.taskType, task.taskPayload);
                    }
                } else {
                    estimatedCredits = estimateTaskCredits(task.taskType, task.taskPayload);
                }

                const requiredCredits = Math.max(task.minCreditsRequired || 0, estimatedCredits);

                if (requiredCredits > 0) {
                    const creditCheck = await this.checkCreditsWithAmount(task, requiredCredits);
                    if (!creditCheck.success) {
                        log.warning(`[SCHEDULER] ${creditCheck.message}`);

                        if (creditCheck.reason === "no_apikey" || creditCheck.reason === "apikey_not_found") {
                            // Critical error: stop the entire task (not just pause)
                            await db
                                .update(schemas.scheduledTasks)
                                .set({
                                    isActive: false,
                                    isPaused: true,
                                    pauseReason: `Auto-stopped: ${creditCheck.message}`,
                                    updatedAt: new Date(),
                                })
                                .where(eq(schemas.scheduledTasks.uuid, task.uuid));

                            log.error(`[SCHEDULER] Task ${task.name} stopped due to missing apiKey`);
                        } else {
                            // Insufficient credits or error: just pause the task
                            await db
                                .update(schemas.scheduledTasks)
                                .set({
                                    isPaused: true,
                                    pauseReason: `Auto-paused: Insufficient credits (required: ${requiredCredits})`,
                                    updatedAt: new Date(),
                                })
                                .where(eq(schemas.scheduledTasks.uuid, task.uuid));

                            log.warning(
                                `[SCHEDULER] Task ${task.name} auto-paused due to insufficient credits (required: ${requiredCredits})`
                            );
                        }

                        // Remove from BullMQ scheduler
                        await this.removeScheduledTask(task.uuid);
                        return;
                    }
                }
            }

            // Check concurrency mode
            if (task.concurrencyMode === "skip") {
                const runningExecution = await db
                    .select()
                    .from(schemas.taskExecutions)
                    .where(
                        sql`${schemas.taskExecutions.scheduledTaskUuid} = ${task.uuid}
                            AND ${schemas.taskExecutions.status} IN ('pending', 'running')`
                    )
                    .limit(1);

                if (runningExecution.length > 0) {
                    log.info(`[SCHEDULER] Task ${task.name} is already running, skipping (concurrency: skip)`);
                    // Still update nextExecutionAt even when skipping
                    await this.updateNextExecutionTime(task);
                    return;
                }
            }
            // For "queue" mode, we don't skip - let it queue up

            // Check daily execution limit
            if (task.maxExecutionsPerDay && task.maxExecutionsPerDay > 0) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                const todayExecutions = await db
                    .select({ count: sql<number>`count(*)` })
                    .from(schemas.taskExecutions)
                    .where(
                        sql`${schemas.taskExecutions.scheduledTaskUuid} = ${task.uuid}
                            AND ${schemas.taskExecutions.createdAt} >= ${today}`
                    );

                const count = todayExecutions[0]?.count || 0;
                if (count >= task.maxExecutionsPerDay) {
                    log.warning(
                        `[SCHEDULER] Task ${task.name} reached daily execution limit (${task.maxExecutionsPerDay})`
                    );
                    // Still update nextExecutionAt even when limit reached
                    await this.updateNextExecutionTime(task);
                    return;
                }
            }

            // Generate idempotency key
            const idempotencyKey = `${task.uuid}-${Date.now()}`;
            const executionNumber = task.totalExecutions + 1;

            // Use transaction to ensure atomicity of execution record creation and job trigger
            // If triggerJob() fails, the execution record will be rolled back
            let jobId: string = "";

            await db.transaction(async (tx: any) => {
                // Create execution record
                executionUuid = randomUUID();
                await tx.insert(schemas.taskExecutions).values({
                    uuid: executionUuid,
                    scheduledTaskUuid: task.uuid,
                    executionNumber: executionNumber,
                    idempotencyKey: idempotencyKey,
                    status: "pending",
                    scheduledFor: new Date(),
                    triggeredBy: "scheduler",
                    createdAt: new Date(),
                });

                log.info(`[SCHEDULER] 🚀 Executing task: ${task.name} (execution #${executionNumber})`);

                // Trigger the actual scrape/crawl job (if this fails, transaction rolls back)
                jobId = await this.triggerJob(task, executionUuid);

                // Update execution with job UUID and status
                await tx
                    .update(schemas.taskExecutions)
                    .set({
                        jobUuid: jobId,
                        status: "running",
                        startedAt: new Date(),
                    })
                    .where(eq(schemas.taskExecutions.uuid, executionUuid));
            });

            // Calculate next execution time
            let nextExecutionAt: Date | null = null;
            try {
                const interval = CronExpressionParser.parse(task.cronExpression, {
                    tz: task.timezone || "UTC",
                    currentDate: new Date(),
                });
                nextExecutionAt = interval.next().toDate();
            } catch (error) {
                log.error(`[SCHEDULER] Failed to calculate next execution for task ${task.name}: ${error}`);
            }

            // Update task statistics
            await db
                .update(schemas.scheduledTasks)
                .set({
                    lastExecutionAt: new Date(),
                    nextExecutionAt: nextExecutionAt,
                    totalExecutions: sql`${schemas.scheduledTasks.totalExecutions} + 1`,
                    consecutiveFailures: 0, // Reset on successful trigger
                })
                .where(eq(schemas.scheduledTasks.uuid, task.uuid));

            log.info(`[SCHEDULER] ✅ Task ${task.name} triggered job ${jobId}`);

            // Trigger webhook for task execution
            try {
                if (process.env.ANYCRAWL_WEBHOOKS_ENABLED === "true") {
                    const { WebhookManager } = await import("./Webhook.js");
                    await WebhookManager.getInstance().triggerEvent(
                        WebhookEventType.TASK_EXECUTED,
                        {
                            task_id: task.uuid,
                            task_name: task.name,
                            task_type: task.taskType,
                            execution_id: executionUuid,
                            execution_number: executionNumber,
                            job_id: jobId,
                            status: "executed",
                        },
                        "task",
                        task.uuid,
                        task.userId ?? undefined
                    );
                }
            } catch (e) {
                log.warning(`[SCHEDULER] Failed to trigger webhook for task execution: ${e}`);
            }
        } catch (error) {
            log.error(`[SCHEDULER] Task ${taskUuid} execution failed: ${error}`);

            // Update the execution record to failed status if it was created
            if (typeof executionUuid !== 'undefined') {
                try {
                    await db
                        .update(schemas.taskExecutions)
                        .set({
                            status: "failed",
                            completedAt: new Date(),
                            errorMessage: error instanceof Error ? error.message : String(error),
                        })
                        .where(eq(schemas.taskExecutions.uuid, executionUuid));
                } catch (updateError) {
                    log.error(`[SCHEDULER] Failed to update execution record to failed: ${updateError}`);
                }
            }

            // Trigger webhook for task failure
            try {
                if (process.env.ANYCRAWL_WEBHOOKS_ENABLED === "true") {
                    const failedTask = await db
                        .select()
                        .from(schemas.scheduledTasks)
                        .where(eq(schemas.scheduledTasks.uuid, taskUuid))
                        .limit(1);

                    if (failedTask[0]) {
                        const { WebhookManager } = await import("./Webhook.js");
                        await WebhookManager.getInstance().triggerEvent(
                            WebhookEventType.TASK_FAILED,
                            {
                                task_id: taskUuid,
                                task_name: failedTask[0].name,
                                task_type: failedTask[0].taskType,
                                status: "failed",
                                error: error instanceof Error ? error.message : String(error),
                            },
                            "task",
                            taskUuid,
                            failedTask[0].userId ?? undefined
                        );
                    }
                }
            } catch (e) {
                log.warning(`[SCHEDULER] Failed to trigger webhook for task failure: ${e}`);
            }

            // Update failure statistics and next execution time
            // Always update nextExecutionAt regardless of success/failure
            let nextExecutionAt: Date | null = null;
            try {
                const taskForCron = await db
                    .select()
                    .from(schemas.scheduledTasks)
                    .where(eq(schemas.scheduledTasks.uuid, taskUuid))
                    .limit(1);

                if (taskForCron[0]) {
                    const interval = CronExpressionParser.parse(taskForCron[0].cronExpression, {
                        tz: taskForCron[0].timezone || "UTC",
                        currentDate: new Date(),
                    });
                    nextExecutionAt = interval.next().toDate();
                }
            } catch (cronError) {
                log.error(`[SCHEDULER] Failed to calculate next execution for failed task ${taskUuid}: ${cronError}`);
            }

            await db
                .update(schemas.scheduledTasks)
                .set({
                    lastExecutionAt: new Date(),
                    nextExecutionAt: nextExecutionAt,
                    failedExecutions: sql`${schemas.scheduledTasks.failedExecutions} + 1`,
                    consecutiveFailures: sql`${schemas.scheduledTasks.consecutiveFailures} + 1`,
                })
                .where(eq(schemas.scheduledTasks.uuid, taskUuid));

            // Auto-pause if too many consecutive failures
            const updatedTask = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(eq(schemas.scheduledTasks.uuid, taskUuid))
                .limit(1);

            if (updatedTask[0]?.consecutiveFailures >= 5) {
                await db
                    .update(schemas.scheduledTasks)
                    .set({
                        isPaused: true,
                        pauseReason: `Auto-paused after ${updatedTask[0].consecutiveFailures} consecutive failures`,
                    })
                    .where(eq(schemas.scheduledTasks.uuid, taskUuid));

                log.warning(
                    `[SCHEDULER] Task auto-paused after ${updatedTask[0].consecutiveFailures} consecutive failures`
                );

                // Remove from repeatable jobs
                await this.removeScheduledTask(taskUuid);
            }

            throw error;
        }
    }

    /**
     * Update the next execution time for a task
     * Called when execution is skipped but we still need to update the schedule
     */
    private async updateNextExecutionTime(task: any): Promise<void> {
        try {
            const db = await getDB();
            const interval = CronExpressionParser.parse(task.cronExpression, {
                tz: task.timezone || "UTC",
                currentDate: new Date(),
            });
            const nextExecutionAt = interval.next().toDate();

            await db
                .update(schemas.scheduledTasks)
                .set({
                    nextExecutionAt: nextExecutionAt,
                    updatedAt: new Date(),
                })
                .where(eq(schemas.scheduledTasks.uuid, task.uuid));

            log.debug(`[SCHEDULER] Updated next execution time for ${task.name}: ${nextExecutionAt}`);
        } catch (error) {
            log.error(`[SCHEDULER] Failed to update next execution time for task ${task.name}: ${error}`);
        }
    }

    private async triggerJob(task: any, executionUuid: string): Promise<string> {
        const queueManager = QueueManager.getInstance();
        const payload = task.taskPayload;
        const db = await getDB();

        let actualTaskType = task.taskType;
        let engine = payload.engine || "cheerio";

        // Handle template task type
        if (task.taskType === "template") {
            // For template tasks, we need to fetch the template to determine the actual type
            const templateId = payload.template_id;
            if (!templateId) {
                throw new Error("Template task requires template_id in payload");
            }

            try {
                const { getTemplate } = await import("@anycrawl/db");
                const template = await getTemplate(templateId);

                if (!template) {
                    // Template deleted - deactivate the scheduled task
                    log.error(`[SCHEDULER] Template ${templateId} not found, deactivating task ${task.uuid}`);

                    await db.update(schemas.scheduledTasks)
                        .set({
                            isActive: false,
                            isPaused: true,
                            pauseReason: `Auto-stopped: Template ${templateId} no longer exists`,
                            updatedAt: new Date(),
                        })
                        .where(eq(schemas.scheduledTasks.uuid, task.uuid));

                    // Remove from BullMQ scheduler
                    await this.removeScheduledTask(task.uuid);

                    throw new Error(`Template ${templateId} not found - task deactivated`);
                }

                // Use the template's type as the actual task type
                actualTaskType = template.templateType;

                // If engine is not specified in payload, use template's engine if available
                if (!payload.engine && template.reqOptions?.engine) {
                    engine = template.reqOptions.engine;
                }
            } catch (error) {
                log.error(`[SCHEDULER] Failed to fetch template ${templateId}: ${error}`);
                throw error;
            }
        }

        // Create queue name based on actual task type and engine
        const queueName = `${actualTaskType}-${engine}`;

        // Get or create the queue
        const queue = queueManager.getQueue(queueName);

        // Generate job ID
        const jobId = randomUUID();

        // Add job to queue
        await queue.add(
            actualTaskType,
            {
                ...payload,
                type: actualTaskType,
                engine: engine,
                scheduled_task_id: task.uuid,
                scheduled_execution_id: executionUuid,
                parentId: jobId,
            },
            {
                jobId: jobId,
            }
        );

        return jobId;
    }

    /**
     * Check if the user/apiKey has enough credits for the task
     * Returns detailed result to distinguish between different failure reasons
     */
    private async checkCreditsWithAmount(
        task: any,
        requiredCredits: number
    ): Promise<
        | { success: true }
        | { success: false; reason: "no_apikey" | "apikey_not_found" | "insufficient_credits" | "error"; message: string }
    > {
        try {
            const db = await getDB();
            const apiKeyId = task.apiKey;

            // apiKey is required for credit check
            if (!apiKeyId) {
                return {
                    success: false,
                    reason: "no_apikey",
                    message: `Task ${task.uuid} has no apiKey bound`,
                };
            }

            // Query the apiKey table for credits
            const apiKeyResult = await db
                .select({ credits: schemas.apiKey.credits })
                .from(schemas.apiKey)
                .where(eq(schemas.apiKey.uuid, apiKeyId))
                .limit(1);

            if (apiKeyResult.length === 0) {
                return {
                    success: false,
                    reason: "apikey_not_found",
                    message: `ApiKey ${apiKeyId} not found for task ${task.uuid}`,
                };
            }

            const credits = apiKeyResult[0].credits || 0;

            // Check if credits are sufficient
            if (credits <= 0 || credits < requiredCredits) {
                return {
                    success: false,
                    reason: "insufficient_credits",
                    message: `Insufficient credits for task ${task.name}: has ${credits}, needs ${requiredCredits}`,
                };
            }

            return { success: true };
        } catch (error) {
            log.error(`[SCHEDULER] Error checking credits for task ${task.uuid}: ${error}`);
            return {
                success: false,
                reason: "error",
                message: `Error checking credits: ${error}`,
            };
        }
    }

    /**
     * Start periodic polling to detect database changes
     * Checks for new or updated tasks every SYNC_INTERVAL_MS
     */
    private startPolling(): void {
        if (this.syncInterval) {
            log.warning("[SCHEDULER] Polling is already active");
            return;
        }

        log.info(`[SCHEDULER] Starting periodic task sync (every ${this.SYNC_INTERVAL_MS / 1000}s)`);

        this.syncInterval = setInterval(async () => {
            try {
                await this.pollDatabaseChanges();
            } catch (error) {
                log.error(`[SCHEDULER] Error in periodic task sync: ${error}`);
            }
        }, this.SYNC_INTERVAL_MS);
    }

    /**
     * Stop periodic polling
     */
    private stopPolling(): void {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
            log.info("[SCHEDULER] Stopped periodic task sync");
        }
    }

    /**
     * Acquire distributed lock for polling to prevent multiple instances from polling simultaneously
     * Uses Redis SETNX with expiry for atomic lock acquisition
     */
    private async acquirePollLock(): Promise<boolean> {
        if (!this.redis) {
            log.warning("[SCHEDULER] Redis not initialized, skipping lock acquisition");
            return false;
        }

        try {
            // Short TTL as a safety net - lock will be explicitly released after polling
            const lockTTL = 60; // 60 seconds max, in case release fails

            // SETNX with expiry - only one instance can hold the lock
            const acquired = await this.redis.set(
                this.POLL_LOCK_KEY,
                `${process.pid}-${Date.now()}`,
                "EX",
                lockTTL,
                "NX"
            );
            return acquired === "OK";
        } catch (error) {
            log.warning(`[SCHEDULER] Failed to acquire poll lock: ${error}`);
            return false;
        }
    }

    /**
     * Release the distributed poll lock after polling completes
     */
    private async releasePollLock(): Promise<void> {
        if (!this.redis) {
            return;
        }

        try {
            await this.redis.del(this.POLL_LOCK_KEY);
        } catch (error) {
            log.warning(`[SCHEDULER] Failed to release poll lock: ${error}`);
        }
    }

    /**
     * Poll database for new or updated tasks since last sync
     * This method detects:
     * 1. New tasks that need to be added to BullMQ
     * 2. Updated tasks that need to be re-synced
     * 3. Paused tasks that need to be removed
     */
    private async pollDatabaseChanges(): Promise<void> {
        // Try to acquire distributed lock - skip if another instance is polling
        if (!await this.acquirePollLock()) {
            log.debug("[SCHEDULER] Another instance is polling, skipping this cycle");
            return;
        }

        try {
            const db = await getDB();

            // Capture query time BEFORE the query to avoid race condition
            // Tasks updated between query and lastSyncTime update would be missed otherwise
            const queryTime = new Date();

            // Query tasks updated since last sync
            const updatedTasks = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(
                    sql`${schemas.scheduledTasks.isActive} = true
                        AND ${schemas.scheduledTasks.updatedAt} >= ${this.lastSyncTime}`
                );

            if (updatedTasks.length > 0) {
                log.info(`[SCHEDULER] 📋 Detected ${updatedTasks.length} new/updated tasks, syncing to BullMQ...`);

                for (const task of updatedTasks) {
                    if (task.isPaused) {
                        // Remove paused tasks from BullMQ
                        await this.removeScheduledTask(task.uuid);
                        log.debug(`[SCHEDULER] Removed paused task: ${task.name}`);
                    } else {
                        // Add or update active tasks
                        await this.addScheduledTask(task);
                        log.debug(`[SCHEDULER] Synced task: ${task.name}`);
                    }
                }

                log.info(`[SCHEDULER] ✅ Synced ${updatedTasks.length} tasks to BullMQ`);
            } else {
                log.debug("[SCHEDULER] No new tasks detected since last sync");
            }

            // Cleanup stale pending executions (stuck for more than 5 minutes without starting)
            await this.cleanupStaleExecutions(db);

            // Enforce subscription tier limits (auto-pause excess tasks on downgrade)
            await this.enforceSubscriptionLimits(db);

            // Update last sync time to query time (not current time) to avoid missing updates
            this.lastSyncTime = queryTime;
        } catch (error) {
            log.error(`[SCHEDULER] Error polling database changes: ${error}`);
        } finally {
            // Always release the lock after polling completes
            await this.releasePollLock();
        }
    }

    /**
     * Cleanup stale executions that are stuck in pending state
     * This handles edge cases like process crashes or hanging triggerJob calls
     */
    private async cleanupStaleExecutions(db: Awaited<ReturnType<typeof getDB>>): Promise<void> {
        try {
            const staleThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago

            const result = await db
                .update(schemas.taskExecutions)
                .set({
                    status: "failed",
                    completedAt: new Date(),
                    errorMessage: "Auto-failed: Execution stuck in pending state (possible process crash or timeout)",
                })
                .where(
                    sql`${schemas.taskExecutions.status} = 'pending'
                        AND ${schemas.taskExecutions.startedAt} IS NULL
                        AND ${schemas.taskExecutions.createdAt} < ${staleThreshold}`
                )
                .returning({ uuid: schemas.taskExecutions.uuid });

            if (result.length > 0) {
                log.warning(`[SCHEDULER] 🧹 Cleaned up ${result.length} stale pending execution(s)`);
            }
        } catch (error) {
            log.error(`[SCHEDULER] Error cleaning up stale executions: ${error}`);
        }
    }

    /**
     * Enforce subscription tier limits
     * Auto-pause excess tasks when user downgrades
     */
    private async enforceSubscriptionLimits(db: Awaited<ReturnType<typeof getDB>>): Promise<void> {
        if (!isScheduledTasksLimitEnabled()) return;

        try {
            // Single JOIN query: get user task counts with subscription tier
            const userStats = await db
                .select({
                    userId: schemas.scheduledTasks.userId,
                    apiKey: schemas.scheduledTasks.apiKey,
                    subscriptionTier: schemas.apiKey.subscriptionTier,
                    taskCount: sql<number>`count(*)`,
                })
                .from(schemas.scheduledTasks)
                .leftJoin(schemas.apiKey, eq(schemas.scheduledTasks.apiKey, schemas.apiKey.uuid))
                .where(sql`${schemas.scheduledTasks.isActive} = true AND ${schemas.scheduledTasks.isPaused} = false`)
                .groupBy(
                    schemas.scheduledTasks.userId,
                    schemas.scheduledTasks.apiKey,
                    schemas.apiKey.subscriptionTier
                );

            for (const userStat of userStats) {
                const tier = userStat.subscriptionTier || "free";
                const limit = getScheduledTasksLimit(tier);
                const count = Number(userStat.taskCount);

                if (count > limit) {
                    // Get tasks to pause (keep oldest, pause newest)
                    const tasksToCheck = await db
                        .select({ uuid: schemas.scheduledTasks.uuid, name: schemas.scheduledTasks.name })
                        .from(schemas.scheduledTasks)
                        .where(
                            sql`${schemas.scheduledTasks.userId} = ${userStat.userId}
                                AND ${schemas.scheduledTasks.isActive} = true
                                AND ${schemas.scheduledTasks.isPaused} = false`
                        )
                        .orderBy(sql`${schemas.scheduledTasks.createdAt} ASC`);

                    // Pause tasks beyond the limit
                    const tasksToPause = tasksToCheck.slice(limit);

                    for (const task of tasksToPause) {
                        await db
                            .update(schemas.scheduledTasks)
                            .set({
                                isPaused: true,
                                pauseReason: buildAutoPauseReason(limit),
                                updatedAt: new Date(),
                            })
                            .where(eq(schemas.scheduledTasks.uuid, task.uuid));

                        await this.removeScheduledTask(task.uuid);
                        log.warning(`[SCHEDULER] Auto-paused task ${task.name} due to subscription limit`);
                    }
                }
            }
        } catch (error) {
            log.error(`[SCHEDULER] Error enforcing subscription limits: ${error}`);
        }
    }

    public async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        log.info("[SCHEDULER] Stopping Scheduler Manager...");

        // Stop polling
        this.stopPolling();

        // Close Redis connection
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }

        this.schedulerQueue = null;
        this.isRunning = false;

        log.info("[SCHEDULER] ✅ Scheduler Manager stopped successfully");
    }

    /**
     * Get count of active job schedulers
     */
    public async getScheduledTasksCount(): Promise<number> {
        if (!this.schedulerQueue) {
            return 0;
        }

        try {
            return await this.schedulerQueue.getJobSchedulersCount();
        } catch (error) {
            log.error(`[SCHEDULER] Failed to get scheduled tasks count: ${error}`);
            return 0;
        }
    }

    /**
     * Get all job schedulers info (for debugging/monitoring)
     */
    public async getJobSchedulers() {
        if (!this.schedulerQueue) {
            return [];
        }

        return await this.schedulerQueue.getJobSchedulers();
    }
}
