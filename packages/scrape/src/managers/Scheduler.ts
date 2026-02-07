import { log } from "crawlee";
import { getDB, schemas, eq, sql, completedJob, failedJob } from "@anycrawl/db";
import { QueueManager } from "./Queue.js";
import { randomUUID } from "crypto";
import { Job, Queue } from "bullmq";
import IORedis from "ioredis";
import { WebhookEventType, estimateTaskCredits, isScheduledTasksLimitEnabled, getScheduledTasksLimit, buildAutoPauseReason, CreditCalculator } from "@anycrawl/libs";
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
     * Cancel a single execution
     *
     * Cancels a scheduled task execution that is currently pending or running.
     * This method will:
     * 1. Validate the execution exists and is in a cancellable state (pending/running)
     * 2. Attempt to remove the associated BullMQ job from the queue (best effort)
     * 3. Update the execution status to "cancelled" in the database
     * 4. Update the job status to "cancelled" if the job exists
     *
     * @param executionUuid - The UUID of the execution to cancel
     * @returns Promise resolving to an object with:
     *   - success: boolean indicating if the cancellation was successful
     *   - message: string describing the result or error
     *
     * @example
     * ```typescript
     * const scheduler = SchedulerManager.getInstance();
     * const result = await scheduler.cancelExecution('execution-uuid');
     * if (result.success) {
     *   console.log('Execution cancelled');
     * } else {
     *   console.error(result.message);
     * }
     * ```
     */
    public async cancelExecution(executionUuid: string): Promise<{ success: boolean; message: string }> {
        try {
            const db = await getDB();

            // Find and validate execution
            const executions = await db
                .select()
                .from(schemas.taskExecutions)
                .where(eq(schemas.taskExecutions.uuid, executionUuid))
                .limit(1);

            if (executions.length === 0) {
                return { success: false, message: `Execution not found` };
            }

            const execution = executions[0];

            if (!["pending", "running"].includes(execution.status)) {
                return { success: false, message: `Execution is already ${execution.status}` };
            }

            // Try to cancel BullMQ job (best effort)
            if (execution.jobUuid) {
                try {
                    const jobs = await db
                        .select()
                        .from(schemas.jobs)
                        .where(eq(schemas.jobs.uuid, execution.jobUuid))
                        .limit(1);

                    if (jobs.length > 0) {
                        const queueManager = QueueManager.getInstance();
                        const queue = queueManager.getQueue(jobs[0].jobQueueName);
                        const bullmqJob = await queue.getJob(jobs[0].jobId);

                        if (bullmqJob) {
                            await bullmqJob.remove();
                        }

                        // Update job status
                        await db
                            .update(schemas.jobs)
                            .set({ status: "cancelled", updatedAt: new Date() })
                            .where(eq(schemas.jobs.uuid, execution.jobUuid));
                    }
                } catch (error) {
                    log.warning(`[SCHEDULER] Failed to cancel BullMQ job: ${error}`);
                }
            }

            // Update execution status
            await db
                .update(schemas.taskExecutions)
                .set({
                    status: "cancelled",
                    completedAt: new Date(),
                    errorMessage: "Cancelled by user",
                })
                .where(eq(schemas.taskExecutions.uuid, executionUuid));

            log.info(`[SCHEDULER] Cancelled execution ${executionUuid}`);
            return { success: true, message: "Execution cancelled successfully" };
        } catch (error) {
            log.error(`[SCHEDULER] Failed to cancel execution: ${error}`);
            return {
                success: false,
                message: error instanceof Error ? error.message : String(error),
            };
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
            let jobUuid: string = "";

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
                // Pass tx to ensure job creation happens in the same transaction
                // Returns the job UUID (database primary key) for foreign key reference
                jobUuid = await this.triggerJob(task, executionUuid, tx);

                // Update execution with job UUID and status
                // Note: startedAt will be set by Worker when job actually starts processing
                await tx
                    .update(schemas.taskExecutions)
                    .set({
                        jobUuid: jobUuid,
                        status: "running",
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

            log.info(`[SCHEDULER] ✅ Task ${task.name} triggered job ${jobUuid}`);

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
                            job_id: jobUuid,
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
                            errorCode: error instanceof Error ? (error.name || 'SCHEDULER_ERROR') : 'SCHEDULER_ERROR',
                            errorDetails: {
                                name: error instanceof Error ? error.name : 'Error',
                                message: error instanceof Error ? error.message : String(error),
                                stack: error instanceof Error ? error.stack : undefined,
                                timestamp: new Date().toISOString(),
                                source: 'scheduler',
                            },
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

    private async triggerJob(task: any, executionUuid: string, dbOrTx?: any): Promise<string> {
        const queueManager = QueueManager.getInstance();
        const payload = task.taskPayload;
        const db = dbOrTx || await getDB();

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

        // Generate job ID
        const jobId = randomUUID();

        // Extract URL from payload based on task type
        let url = "scheduled-task";
        if (payload.url) {
            url = payload.url;
            // Ensure URL has protocol
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = `https://${url}`;
            }
        } else if (payload.query) {
            url = `search:${payload.query}`;
        } else if (actualTaskType === "map" && payload.url) {
            url = payload.url;
            // Ensure URL has protocol
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = `https://${url}`;
            }
        }

        // Handle search and map tasks synchronously (they don't have dedicated workers)
        if (actualTaskType === "search" || actualTaskType === "map") {
            return await this.executeSearchOrMapTask(
                actualTaskType,
                task,
                payload,
                jobId,
                url,
                executionUuid,
                db
            );
        }

        // For scrape/crawl tasks, add to queue for async processing
        // Prepare job data - also fix URL in payload
        const jobData = {
            ...payload,
            url: payload.url && !payload.url.startsWith('http://') && !payload.url.startsWith('https://')
                ? `https://${payload.url}`
                : payload.url,
            type: actualTaskType,
            engine: engine,
            queueName: queueName,  // Add queueName field
            scheduled_task_id: task.uuid,
            scheduled_execution_id: executionUuid,
            parentId: jobId,
        };

        // Add job to queue using QueueManager (like other controllers do)
        log.info(`[SCHEDULER] Adding job to queue: ${queueName}`);
        log.info(`[SCHEDULER]   Job ID: ${jobId}`);
        log.info(`[SCHEDULER]   URL: ${jobData.url}`);
        log.info(`[SCHEDULER]   Type: ${jobData.type}`);
        log.info(`[SCHEDULER]   Engine: ${jobData.engine}`);
        log.info(`[SCHEDULER]   QueueName: ${jobData.queueName}`);

        await queueManager.getQueue(queueName).add(
            queueName,  // Use queueName as job name
            jobData,
            {
                jobId: jobId,
                attempts: 3,
                backoff: {
                    type: "exponential",
                    delay: 1000,
                },
            }
        );

        log.info(`[SCHEDULER] Job added to BullMQ queue successfully`);

        // Then create job record in database
        // This ensures the foreign key constraint is satisfied when task_executions references this job
        const insertedJob = await db.insert(schemas.jobs).values({
            jobId: jobId,
            jobType: actualTaskType,
            jobQueueName: queueName,
            jobExpireAt: new Date(Date.now() + 3 * 60 * 60 * 1000), // 3 hours default
            url: url,
            payload: payload,
            status: "pending",
            apiKey: task.apiKey,
            userId: task.userId,
            origin: "scheduled-task", // Origin is "scheduled-task" not "scheduler"
            isSuccess: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        }).returning({ uuid: schemas.jobs.uuid });

        // Get the UUID of the inserted job (this is what task_executions.jobUuid references)
        const jobUuid = insertedJob[0].uuid;

        // Return the job UUID (not jobId) - this is what task_executions.jobUuid references
        return jobUuid;
    }

    /**
     * Execute search or map task synchronously
     * These tasks don't have dedicated workers, so we execute them directly in the scheduler
     */
    private async executeSearchOrMapTask(
        taskType: "search" | "map",
        task: any,
        payload: any,
        jobId: string,
        url: string,
        executionUuid: string,
        db: any
    ): Promise<string> {
        const startedAt = new Date();
        let creditsUsed = 0;
        let isSuccess = false;
        let errorMessage: string | undefined;
        let errorCode: string | undefined;
        let errorDetails: any | undefined;
        let resultData: any;

        log.info(`[SCHEDULER] Executing ${taskType} task synchronously: ${task.name}`);
        log.info(`[SCHEDULER]   Job ID: ${jobId}`);
        log.info(`[SCHEDULER]   URL: ${url}`);

        // Create job record first
        const insertedJob = await db.insert(schemas.jobs).values({
            jobId: jobId,
            jobType: taskType,
            jobQueueName: `${taskType}-sync`,
            jobExpireAt: new Date(Date.now() + 1 * 60 * 60 * 1000), // 1 hour for sync tasks
            url: url,
            payload: payload,
            status: "pending",
            apiKey: task.apiKey,
            userId: task.userId,
            origin: "scheduled-task",
            isSuccess: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        }).returning({ uuid: schemas.jobs.uuid });

        const jobUuid = insertedJob[0].uuid;

        try {
            if (taskType === "search") {
                // Execute search task
                // @ts-ignore - Dynamic import to avoid circular dependency
                const { SearchService } = await import("@anycrawl/search");
                const searchService = new SearchService({
                    defaultEngine: process.env.ANYCRAWL_SEARCH_DEFAULT_ENGINE,
                    enabledEngines: process.env.ANYCRAWL_SEARCH_ENABLED_ENGINES?.split(',').map(e => e.trim()),
                    searxngUrl: process.env.ANYCRAWL_SEARXNG_URL,
                    acEngineUrl: process.env.ANYCRAWL_AC_ENGINE_URL,
                });

                const results = await searchService.search(payload.engine, {
                    query: payload.query,
                    limit: payload.limit,
                    offset: payload.offset,
                    lang: payload.lang,
                    country: payload.country,
                    timeRange: payload.timeRange,
                    sources: payload.sources,
                    safe_search: payload.safe_search,
                });

                resultData = results;
                creditsUsed = CreditCalculator.calculateSearchCredits({
                    pages: payload.pages,
                });
                isSuccess = true;

                log.info(`[SCHEDULER] Search completed: ${results.length} results`);

            } else if (taskType === "map") {
                // Execute map task
                const { MapService } = await import("../services/MapService.js");
                // @ts-ignore - Dynamic import to avoid circular dependency
                const { SearchService } = await import("@anycrawl/search");

                const mapService = new MapService();
                const searchService = new SearchService({
                    defaultEngine: process.env.ANYCRAWL_SEARCH_DEFAULT_ENGINE,
                    enabledEngines: process.env.ANYCRAWL_SEARCH_ENABLED_ENGINES?.split(',').map(e => e.trim()),
                    searxngUrl: process.env.ANYCRAWL_SEARXNG_URL,
                    acEngineUrl: process.env.ANYCRAWL_AC_ENGINE_URL,
                });

                const mapUrl = payload.url?.startsWith('http://') || payload.url?.startsWith('https://')
                    ? payload.url
                    : `https://${payload.url}`;

                const result = await mapService.map(mapUrl, {
                    limit: payload.limit,
                    includeSubdomains: payload.include_subdomains,
                    ignoreSitemap: payload.ignore_sitemap,
                    searchService: searchService,
                });

                resultData = result.links;
                creditsUsed = CreditCalculator.calculateMapCredits({});
                isSuccess = true;

                log.info(`[SCHEDULER] Map completed: ${result.links.length} links`);
            }

            // Update job as completed
            await completedJob(jobId, true, {
                total: Array.isArray(resultData) ? resultData.length : 1,
                completed: Array.isArray(resultData) ? resultData.length : 1,
                failed: 0,
            });

        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error);
            errorCode = error instanceof Error ? (error.name || 'SYNC_TASK_ERROR') : 'SYNC_TASK_ERROR';
            errorDetails = {
                name: error instanceof Error ? error.name : 'Error',
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                timestamp: new Date().toISOString(),
                source: 'scheduler',
                taskType: taskType,
            };
            log.error(`[SCHEDULER] ${taskType} task failed: ${errorMessage}`);

            // Update job as failed
            await failedJob(jobId, errorMessage, false, { total: 1, completed: 0, failed: 1 });
        }

        // Deduct credits if successful and credits are enabled
        if (isSuccess && creditsUsed > 0 && process.env.ANYCRAWL_API_CREDITS_ENABLED === 'true' && task.apiKey) {
            try {
                await db.transaction(async (tx: any) => {
                    // Update job creditsUsed
                    await tx.update(schemas.jobs).set({
                        creditsUsed: creditsUsed,
                        deductedAt: new Date(),
                        updatedAt: new Date(),
                    }).where(eq(schemas.jobs.jobId, jobId));

                    // Deduct from apiKey
                    await tx.update(schemas.apiKey).set({
                        credits: sql`${schemas.apiKey.credits} - ${creditsUsed}`,
                        lastUsedAt: new Date(),
                    }).where(eq(schemas.apiKey.uuid, task.apiKey));

                    log.info(`[SCHEDULER] Deducted ${creditsUsed} credits for ${taskType} task`);
                });
            } catch (creditError) {
                log.error(`[SCHEDULER] Failed to deduct credits: ${creditError}`);
            }
        }

        // Update execution record with startedAt and completedAt
        const completedAt = new Date();
        await db.update(schemas.taskExecutions).set({
            startedAt: startedAt,
            completedAt: completedAt,
            status: isSuccess ? "completed" : "failed",
            errorMessage: errorMessage,
            errorCode: errorCode,
            errorDetails: errorDetails,
        }).where(eq(schemas.taskExecutions.uuid, executionUuid));

        return jobUuid;
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

            // Case 1: Pending executions that never started (startedAt IS NULL)
            const result = await db
                .update(schemas.taskExecutions)
                .set({
                    status: "failed",
                    completedAt: new Date(),
                    errorMessage: "Auto-failed: Execution stuck in pending state (possible process crash or timeout)",
                    errorCode: "STALE_PENDING_TIMEOUT",
                    errorDetails: {
                        reason: "pending_timeout",
                        threshold_minutes: 5,
                        timestamp: new Date().toISOString(),
                    },
                })
                .where(
                    sql`${schemas.taskExecutions.status} = 'pending'
                        AND ${schemas.taskExecutions.startedAt} IS NULL
                        AND ${schemas.taskExecutions.createdAt} < ${staleThreshold}`
                )
                .returning({ uuid: schemas.taskExecutions.uuid });

            if (result.length > 0) {
                log.warning(`[SCHEDULER] 🧹 Cleaned up ${result.length} stale pending execution(s) (never started)`);
            }

            // Case 2: Pending executions that have startedAt but status never changed to running
            // This can happen if worker crashed after markExecutionStarted but before status update
            const stalePendingWithStart = await db
                .update(schemas.taskExecutions)
                .set({
                    status: "failed",
                    completedAt: new Date(),
                    errorMessage: "Auto-failed: Execution stuck in pending state with startedAt set (worker crash)",
                    errorCode: "STALE_PENDING_STARTED",
                    errorDetails: {
                        reason: "pending_started_timeout",
                        threshold_minutes: 5,
                        timestamp: new Date().toISOString(),
                    },
                })
                .where(
                    sql`${schemas.taskExecutions.status} = 'pending'
                        AND ${schemas.taskExecutions.startedAt} IS NOT NULL
                        AND ${schemas.taskExecutions.startedAt} < ${staleThreshold}`
                )
                .returning({ uuid: schemas.taskExecutions.uuid });

            if (stalePendingWithStart.length > 0) {
                log.warning(`[SCHEDULER] 🧹 Cleaned up ${stalePendingWithStart.length} stale pending execution(s) (started but stuck)`);
            }

            // Also cleanup stale running executions based on task type
            await this.cleanupStaleRunningExecutions(db);
        } catch (error) {
            log.error(`[SCHEDULER] Error cleaning up stale executions: ${error}`);
        }
    }

    /**
     * Cleanup stale running executions based on task type
     * Different task types have different timeout thresholds:
     * - scrape: 30 minutes (single page should not take longer)
     * - search: 1 hour (searches up to 200 results, each result may be scraped)
     * - map: 30 minutes (sitemap + search discovery)
     * - crawl: 1 hour since last job activity (checks jobs table for recent updates)
     * - template: resolved to actual type from jobs.jobType
     */
    private async cleanupStaleRunningExecutions(db: Awaited<ReturnType<typeof getDB>>): Promise<void> {
        try {
            // Timeout thresholds in milliseconds
            const SCRAPE_TIMEOUT_MS = 30 * 60 * 1000;  // 30 minutes
            const SEARCH_TIMEOUT_MS = 60 * 60 * 1000;  // 1 hour (searches + scrapes multiple pages)
            const MAP_TIMEOUT_MS = 30 * 60 * 1000;     // 30 minutes
            const CRAWL_INACTIVITY_MS = 60 * 60 * 1000; // 1 hour of inactivity
            const RUNNING_NO_START_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for running without startedAt

            const now = new Date();

            // Case 0: Running executions that never had startedAt set (Worker never picked up the job)
            // This can happen if Worker crashed, queue mismatch, or job was never processed
            const runningNoStartThreshold = new Date(now.getTime() - RUNNING_NO_START_TIMEOUT_MS);
            const staleRunningNoStart = await db
                .update(schemas.taskExecutions)
                .set({
                    status: "failed",
                    completedAt: now,
                    errorMessage: "Auto-failed: Execution stuck in running state without startedAt (Worker never started processing)",
                    errorCode: "RUNNING_NO_START_TIMEOUT",
                    errorDetails: {
                        reason: "running_no_start",
                        threshold_minutes: Math.round(RUNNING_NO_START_TIMEOUT_MS / 60000),
                        timestamp: now.toISOString(),
                    },
                })
                .where(
                    sql`${schemas.taskExecutions.status} = 'running'
                        AND ${schemas.taskExecutions.startedAt} IS NULL
                        AND ${schemas.taskExecutions.createdAt} < ${runningNoStartThreshold}`
                )
                .returning({ uuid: schemas.taskExecutions.uuid, scheduledTaskUuid: schemas.taskExecutions.scheduledTaskUuid });

            if (staleRunningNoStart.length > 0) {
                log.warning(`[SCHEDULER] 🧹 Cleaned up ${staleRunningNoStart.length} stale running execution(s) (never started)`);

                // Update failedExecutions counter for affected tasks
                for (const exec of staleRunningNoStart) {
                    if (exec.scheduledTaskUuid) {
                        await db
                            .update(schemas.scheduledTasks)
                            .set({
                                failedExecutions: sql`${schemas.scheduledTasks.failedExecutions} + 1`,
                                consecutiveFailures: sql`${schemas.scheduledTasks.consecutiveFailures} + 1`,
                                updatedAt: now,
                            })
                            .where(eq(schemas.scheduledTasks.uuid, exec.scheduledTaskUuid));
                    }
                }
            }

            // Get all running executions with their task info and job type
            // For template tasks, we need the actual job type from jobs table
            const runningExecutions = await db
                .select({
                    executionUuid: schemas.taskExecutions.uuid,
                    scheduledTaskUuid: schemas.taskExecutions.scheduledTaskUuid,
                    jobUuid: schemas.taskExecutions.jobUuid,
                    startedAt: schemas.taskExecutions.startedAt,
                    taskType: schemas.scheduledTasks.taskType,
                    jobType: schemas.jobs.jobType,
                    jobUpdatedAt: schemas.jobs.updatedAt,
                })
                .from(schemas.taskExecutions)
                .innerJoin(
                    schemas.scheduledTasks,
                    eq(schemas.taskExecutions.scheduledTaskUuid, schemas.scheduledTasks.uuid)
                )
                .leftJoin(
                    schemas.jobs,
                    eq(schemas.taskExecutions.jobUuid, schemas.jobs.uuid)
                )
                .where(eq(schemas.taskExecutions.status, "running"));

            let cleanedCount = 0;

            for (const execution of runningExecutions) {
                // Skip if startedAt is null - these are handled by Case 0 above
                if (!execution.startedAt) continue;

                const runningTime = now.getTime() - new Date(execution.startedAt).getTime();
                let shouldTimeout = false;
                let timeoutReason = "";
                let thresholdMinutes = 0;

                // Determine actual task type:
                // - For template tasks, use jobType from jobs table (the actual executed type)
                // - Otherwise use taskType from scheduled_tasks
                const scheduledTaskType = execution.taskType?.toLowerCase() || "scrape";
                const actualTaskType = scheduledTaskType === "template"
                    ? (execution.jobType?.toLowerCase() || "scrape")
                    : scheduledTaskType;

                if (actualTaskType === "crawl") {
                    // For crawl tasks, check if there's been recent activity on the job
                    if (execution.jobUuid && execution.jobUpdatedAt) {
                        const lastActivity = new Date(execution.jobUpdatedAt).getTime();
                        const inactiveTime = now.getTime() - lastActivity;

                        if (inactiveTime > CRAWL_INACTIVITY_MS) {
                            shouldTimeout = true;
                            timeoutReason = "crawl_inactivity";
                            thresholdMinutes = Math.round(CRAWL_INACTIVITY_MS / 60000);
                        }
                    } else if (runningTime > CRAWL_INACTIVITY_MS) {
                        // No job found or no updatedAt, use running time
                        shouldTimeout = true;
                        timeoutReason = "crawl_no_activity";
                        thresholdMinutes = Math.round(CRAWL_INACTIVITY_MS / 60000);
                    }
                } else if (actualTaskType === "search") {
                    if (runningTime > SEARCH_TIMEOUT_MS) {
                        shouldTimeout = true;
                        timeoutReason = "search_timeout";
                        thresholdMinutes = Math.round(SEARCH_TIMEOUT_MS / 60000);
                    }
                } else if (actualTaskType === "map") {
                    if (runningTime > MAP_TIMEOUT_MS) {
                        shouldTimeout = true;
                        timeoutReason = "map_timeout";
                        thresholdMinutes = Math.round(MAP_TIMEOUT_MS / 60000);
                    }
                } else {
                    // scrape (default)
                    if (runningTime > SCRAPE_TIMEOUT_MS) {
                        shouldTimeout = true;
                        timeoutReason = "scrape_timeout";
                        thresholdMinutes = Math.round(SCRAPE_TIMEOUT_MS / 60000);
                    }
                }

                if (shouldTimeout) {
                    // Update execution to failed
                    await db
                        .update(schemas.taskExecutions)
                        .set({
                            status: "failed",
                            completedAt: now,
                            errorMessage: `Auto-failed: Execution timed out after ${thresholdMinutes} minutes (${timeoutReason})`,
                            errorCode: "EXECUTION_TIMEOUT",
                            errorDetails: {
                                reason: timeoutReason,
                                threshold_minutes: thresholdMinutes,
                                running_time_ms: runningTime,
                                scheduled_task_type: scheduledTaskType,
                                actual_task_type: actualTaskType,
                                timestamp: now.toISOString(),
                            },
                        })
                        .where(eq(schemas.taskExecutions.uuid, execution.executionUuid));

                    // Update scheduled_tasks failedExecutions counter
                    if (execution.scheduledTaskUuid) {
                        await db
                            .update(schemas.scheduledTasks)
                            .set({
                                failedExecutions: sql`${schemas.scheduledTasks.failedExecutions} + 1`,
                                consecutiveFailures: sql`${schemas.scheduledTasks.consecutiveFailures} + 1`,
                                updatedAt: now,
                            })
                            .where(eq(schemas.scheduledTasks.uuid, execution.scheduledTaskUuid));
                    }

                    // Also update the associated job if exists
                    if (execution.jobUuid) {
                        await db
                            .update(schemas.jobs)
                            .set({
                                status: "failed",
                                errorMessage: `Execution timed out after ${thresholdMinutes} minutes`,
                                isSuccess: false,
                                updatedAt: now,
                            })
                            .where(eq(schemas.jobs.uuid, execution.jobUuid));
                    }

                    cleanedCount++;
                    log.warning(
                        `[SCHEDULER] 🧹 Timed out execution ${execution.executionUuid} ` +
                        `(type: ${actualTaskType}${scheduledTaskType === "template" ? " (template)" : ""}, ` +
                        `reason: ${timeoutReason}, running: ${Math.round(runningTime / 60000)}min)`
                    );
                }
            }

            if (cleanedCount > 0) {
                log.warning(`[SCHEDULER] 🧹 Cleaned up ${cleanedCount} stale running execution(s)`);
            }
        } catch (error) {
            log.error(`[SCHEDULER] Error cleaning up stale running executions: ${error}`);
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
