import { log } from "crawlee";
import { getDB, schemas, eq, sql } from "@anycrawl/db";
import { QueueManager } from "./Queue.js";
import { randomUUID } from "crypto";
import { Job, Queue } from "bullmq";

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
    private readonly SCHEDULER_QUEUE_NAME = "scheduler";
    private syncInterval: NodeJS.Timeout | null = null;
    private lastSyncTime: Date = new Date();
    private readonly SYNC_INTERVAL_MS: number;

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
            const tasks = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(eq(schemas.scheduledTasks.isActive, true));

            log.info(`[SCHEDULER] Syncing ${tasks.length} active scheduled tasks to BullMQ`);

            for (const task of tasks) {
                if (task.isPaused) {
                    // Remove paused tasks from repeatable jobs
                    await this.removeScheduledTask(task.uuid);
                } else {
                    // Add or update as repeatable job
                    await this.addScheduledTask(task);
                }
            }

            log.info(`[SCHEDULER] ✅ Synced ${tasks.length} tasks to BullMQ`);
        } catch (error) {
            log.error(`[SCHEDULER] Error syncing scheduled tasks: ${error}`);
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
            // Remove existing repeatable job if it exists (to update configuration)
            await this.removeScheduledTask(task.uuid);

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
     * Uses the known jobId pattern for efficient removal
     */
    public async removeScheduledTask(taskUuid: string): Promise<void> {
        if (!this.schedulerQueue) {
            return;
        }

        try {
            // Use the known jobId pattern instead of iterating through all schedulers
            const jobId = `scheduled:${taskUuid}`;
            const jobSchedulers = await this.schedulerQueue.getJobSchedulers();

            // Find the job scheduler with matching jobId
            const schedulerToRemove = jobSchedulers.find(scheduler => scheduler.id === jobId);

            if (schedulerToRemove) {
                await this.schedulerQueue.removeJobScheduler(schedulerToRemove.key);
                log.debug(`[SCHEDULER] Removed job scheduler for task ${taskUuid}`);
            }
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

            // Check credits (always enabled, consistent with API behavior)
            // Only check if ANYCRAWL_API_CREDITS_ENABLED is true
            const creditsEnabled = process.env.ANYCRAWL_API_CREDITS_ENABLED === "true";
            if (creditsEnabled && task.minCreditsRequired > 0) {
                const hasEnoughCredits = await this.checkCredits(task);
                if (!hasEnoughCredits) {
                    // Auto-pause the task
                    await db
                        .update(schemas.scheduledTasks)
                        .set({
                            isPaused: true,
                            pauseReason: `Auto-paused: Insufficient credits (required: ${task.minCreditsRequired})`,
                            updatedAt: new Date(),
                        })
                        .where(eq(schemas.scheduledTasks.uuid, task.uuid));

                    log.warning(
                        `[SCHEDULER] Task ${task.name} auto-paused due to insufficient credits (required: ${task.minCreditsRequired})`
                    );

                    // Remove from BullMQ scheduler
                    await this.removeScheduledTask(task.uuid);
                    return;
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
                    return;
                }
            }

            // Generate idempotency key
            const idempotencyKey = `${task.uuid}-${Date.now()}`;
            const executionNumber = task.totalExecutions + 1;

            // Create execution record
            const executionUuid = randomUUID();
            await db.insert(schemas.taskExecutions).values({
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

            // Trigger the actual scrape/crawl job
            const jobId = await this.triggerJob(task, executionUuid);

            // Update execution with job UUID and status
            await db
                .update(schemas.taskExecutions)
                .set({
                    jobUuid: jobId,
                    status: "running",
                    startedAt: new Date(),
                })
                .where(eq(schemas.taskExecutions.uuid, executionUuid));

            // Update task statistics
            await db
                .update(schemas.scheduledTasks)
                .set({
                    lastExecutionAt: new Date(),
                    totalExecutions: sql`${schemas.scheduledTasks.totalExecutions} + 1`,
                    consecutiveFailures: 0, // Reset on successful trigger
                })
                .where(eq(schemas.scheduledTasks.uuid, task.uuid));

            log.info(`[SCHEDULER] ✅ Task ${task.name} triggered job ${jobId}`);
        } catch (error) {
            log.error(`[SCHEDULER] Task ${taskUuid} execution failed: ${error}`);

            // Update failure statistics
            await db
                .update(schemas.scheduledTasks)
                .set({
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

    private async triggerJob(task: any, executionUuid: string): Promise<string> {
        const queueManager = QueueManager.getInstance();
        const payload = task.taskPayload;

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
                    throw new Error(`Template ${templateId} not found`);
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
     * Consistent with API CheckCreditsMiddleware behavior
     */
    private async checkCredits(task: any): Promise<boolean> {
        try {
            const db = await getDB();

            // Get the apiKey or userId from the task
            const apiKeyId = task.apiKey;
            const userId = task.userId;

            if (!apiKeyId && !userId) {
                // No auth info, assume credits are sufficient
                log.warning(`[SCHEDULER] Task ${task.uuid} has no apiKey or userId, skipping credit check`);
                return true;
            }

            // Query the apiKey table for credits
            let credits = 0;
            if (apiKeyId) {
                const apiKeyResult = await db
                    .select({ credits: schemas.apiKey.credits })
                    .from(schemas.apiKey)
                    .where(eq(schemas.apiKey.uuid, apiKeyId))
                    .limit(1);

                if (apiKeyResult.length > 0) {
                    credits = apiKeyResult[0].credits || 0;
                }
            } else if (userId) {
                // If only userId is available, find the user's primary apiKey
                const apiKeyResult = await db
                    .select({ credits: schemas.apiKey.credits })
                    .from(schemas.apiKey)
                    .where(eq(schemas.apiKey.user, userId))
                    .limit(1);

                if (apiKeyResult.length > 0) {
                    credits = apiKeyResult[0].credits || 0;
                }
            }

            // Check if credits are sufficient (consistent with API: credits <= 0 means insufficient)
            const hasEnough = credits > 0 && credits >= task.minCreditsRequired;
            if (!hasEnough) {
                log.warning(
                    `[SCHEDULER] Insufficient credits for task ${task.name}: has ${credits}, needs ${task.minCreditsRequired}`
                );
            }

            return hasEnough;
        } catch (error) {
            log.error(`[SCHEDULER] Error checking credits for task ${task.uuid}: ${error}`);
            // On error, assume credits are sufficient to avoid blocking tasks
            return true;
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
     * Poll database for new or updated tasks since last sync
     * This method detects:
     * 1. New tasks that need to be added to BullMQ
     * 2. Updated tasks that need to be re-synced
     * 3. Paused tasks that need to be removed
     */
    private async pollDatabaseChanges(): Promise<void> {
        try {
            const db = await getDB();

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

            // Update last sync time
            this.lastSyncTime = new Date();
        } catch (error) {
            log.error(`[SCHEDULER] Error polling database changes: ${error}`);
        }
    }

    public async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        log.info("[SCHEDULER] Stopping Scheduler Manager...");

        // Stop polling
        this.stopPolling();

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
