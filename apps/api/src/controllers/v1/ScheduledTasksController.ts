import { Response } from "express";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import crypto from "crypto";
import { RequestWithAuth, estimateTaskCredits, WebhookEventType, isScheduledTasksLimitEnabled, getScheduledTasksLimit, buildLimitExceededResponse } from "@anycrawl/libs";
import { getDB, schemas, eq, sql } from "@anycrawl/db";
import { log } from "@anycrawl/libs";
import { randomUUID } from "crypto";
import { serializeRecord, serializeRecords } from "../../utils/serializer.js";

// Validation schemas
const createTaskSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().nullable().optional(),
    cron_expression: z.string().refine(
        (val) => {
            try {
                CronExpressionParser.parse(val);
                return true;
            } catch {
                return false;
            }
        },
        "Invalid cron expression"
    ),
    timezone: z.string().default("UTC"),
    task_type: z.enum(["scrape", "crawl", "search", "template"]),
    task_payload: z.object({}).passthrough(),
    concurrency_mode: z.enum(["skip", "queue"]).default("skip"),
    max_executions_per_day: z.number().int().positive().nullable().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.any()).optional(),
    // Webhook integration options
    webhook_ids: z.array(z.string().uuid()).optional(),
    webhook_url: z.string().url().optional(),
});

const updateTaskSchema = createTaskSchema.partial();

// Icon mappings
const TASK_TYPE_ICONS: Record<string, string> = {
    scrape: "FileText",
    crawl: "Network",
    search: "Search",
    template: "FileCode",
};

const EXECUTION_STATUS_ICONS: Record<string, string> = {
    completed: "CircleCheck",
    failed: "CircleX",
    running: "Loader",
    pending: "Clock",
    cancelled: "Ban",
};

export class ScheduledTasksController {
    /**
     * Create a new scheduled task
     */
    public create = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const validatedData = createTaskSchema.parse(req.body);
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            // Check scheduled tasks limit
            if (isScheduledTasksLimitEnabled() && apiKeyId) {
                const db = await getDB();

                // Single query: get tier and task count together
                const result = await db
                    .select({
                        subscriptionTier: schemas.apiKey.subscriptionTier,
                        taskCount: sql<number>`(
                            SELECT count(*) FROM scheduled_tasks
                            WHERE is_active = true
                            AND user_id = ${userId || apiKeyId}
                        )`,
                    })
                    .from(schemas.apiKey)
                    .where(eq(schemas.apiKey.uuid, apiKeyId))
                    .limit(1);

                const tier = result[0]?.subscriptionTier || "free";
                const limit = getScheduledTasksLimit(tier);
                const currentCount = Number(result[0]?.taskCount || 0);

                if (currentCount >= limit) {
                    res.status(403).json(buildLimitExceededResponse(tier, limit, currentCount));
                    return;
                }
            }

            // Calculate min_credits_required automatically
            let template = null;

            // Fetch template if template_id is provided
            if (validatedData.task_payload.template_id) {
                try {
                    const { getTemplate } = await import("@anycrawl/db");
                    template = await getTemplate(String(validatedData.task_payload.template_id));
                } catch (error) {
                    log.warning(`Failed to fetch template for credit calculation: ${error}`);
                }
            }

            // Calculate credits (with or without template)
            const minCreditsRequired = estimateTaskCredits(
                validatedData.task_type,
                validatedData.task_payload,
                template ? { template } : undefined
            );

            // Calculate next execution time
            const nextExecution = this.calculateNextExecution(
                validatedData.cron_expression,
                validatedData.timezone
            );

            const db = await getDB();
            const taskUuid = randomUUID();

            // Store both apiKey and userId (dual field storage)
            await db.insert(schemas.scheduledTasks).values({
                uuid: taskUuid,
                apiKey: apiKeyId,                    // Track which API key created this task
                userId: userId || null,              // Track which user owns this task (can be null)
                name: validatedData.name,
                description: validatedData.description,
                cronExpression: validatedData.cron_expression,
                timezone: validatedData.timezone,
                taskType: validatedData.task_type,
                taskPayload: validatedData.task_payload,
                concurrencyMode: validatedData.concurrency_mode,
                maxExecutionsPerDay: validatedData.max_executions_per_day,
                minCreditsRequired: minCreditsRequired,
                isActive: true,
                isPaused: false,
                nextExecutionAt: nextExecution,
                tags: validatedData.tags,
                metadata: validatedData.metadata,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            // Handle webhook associations
            await this.handleWebhookAssociations(
                taskUuid,
                validatedData.webhook_ids,
                validatedData.webhook_url,
                apiKeyId,
                userId
            );

            // Add to BullMQ scheduler (only if scheduler is running)
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();

                if (scheduler.isSchedulerRunning()) {
                    const createdTask = await db
                        .select()
                        .from(schemas.scheduledTasks)
                        .where(eq(schemas.scheduledTasks.uuid, taskUuid))
                        .limit(1);

                    if (createdTask.length > 0) {
                        await scheduler.addScheduledTask(createdTask[0]);
                    }
                } else {
                    // Scheduler runs in a separate worker process - it will pick up the task via polling
                    log.debug(`Task created in database. Scheduler worker will sync via polling.`);
                }
            } catch (error) {
                log.warning(`Failed to add task to scheduler: ${error}`);
            }

            res.status(201).json({
                success: true,
                data: {
                    task_id: taskUuid,
                    next_execution_at: nextExecution?.toISOString(),
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * List all scheduled tasks for the authenticated API key
     */
    public list = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const db = await getDB();

            // Query by userId if exists, otherwise by apiKey, otherwise all tasks
            const tasks = userId
                ? await db
                    .select()
                    .from(schemas.scheduledTasks)
                    .where(eq(schemas.scheduledTasks.userId, userId))
                    .orderBy(sql`${schemas.scheduledTasks.createdAt} DESC`)
                : apiKeyId
                ? await db
                    .select()
                    .from(schemas.scheduledTasks)
                    .where(eq(schemas.scheduledTasks.apiKey, apiKeyId))
                    .orderBy(sql`${schemas.scheduledTasks.createdAt} DESC`)
                : await db
                    .select()
                    .from(schemas.scheduledTasks)
                    .orderBy(sql`${schemas.scheduledTasks.createdAt} DESC`);

            // Convert to snake_case
            const serialized = serializeRecords(tasks);

            res.json({
                success: true,
                data: serialized,
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get a specific scheduled task
     */
    public get = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const db = await getDB();

            // Check ownership by userId if exists, otherwise by apiKey, otherwise just by taskId
            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            const task = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(whereClause)
                .limit(1);

            if (!task.length) {
                res.status(404).json({
                    success: false,
                    error: "Task not found",
                });
                return;
            }

            // Convert to snake_case
            const serialized = serializeRecord(task[0]);

            // Add icon based on task type
            const icon = TASK_TYPE_ICONS[task[0].taskType] || "Calendar";

            res.json({
                success: true,
                data: {
                    ...serialized,
                    icon,
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Update a scheduled task
     */
    public update = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const validatedData = updateTaskSchema.parse(req.body);
            const db = await getDB();

            // Check task exists and belongs to user/apiKey, or just check existence if no auth
            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            const existing = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(whereClause)
                .limit(1);

            if (!existing.length) {
                res.status(404).json({
                    success: false,
                    error: "Task not found",
                });
                return;
            }

            const updateData: any = {
                ...validatedData,
                updatedAt: new Date(),
            };

            // Recalculate next execution if cron expression changed
            if (validatedData.cron_expression) {
                updateData.cronExpression = validatedData.cron_expression;
                updateData.nextExecutionAt = this.calculateNextExecution(
                    validatedData.cron_expression,
                    validatedData.timezone || existing[0].timezone
                );
                delete updateData.cron_expression;
            }

            // Map snake_case to camelCase
            if (validatedData.task_type) updateData.taskType = validatedData.task_type;
            if (validatedData.task_payload) updateData.taskPayload = validatedData.task_payload;
            if (validatedData.concurrency_mode) updateData.concurrencyMode = validatedData.concurrency_mode;
            if (validatedData.max_executions_per_day) updateData.maxExecutionsPerDay = validatedData.max_executions_per_day;

            // Remove snake_case fields
            delete updateData.task_type;
            delete updateData.task_payload;
            delete updateData.concurrency_mode;
            delete updateData.max_executions_per_day;

            await db
                .update(schemas.scheduledTasks)
                .set(updateData)
                .where(eq(schemas.scheduledTasks.uuid, taskId));

            // Handle webhook associations if provided
            if (validatedData.webhook_ids || validatedData.webhook_url) {
                await this.handleWebhookAssociations(
                    taskId!,
                    validatedData.webhook_ids,
                    validatedData.webhook_url,
                    apiKeyId || undefined,
                    userId || undefined
                );
            }

            // Fetch the updated task
            const updatedTask = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(eq(schemas.scheduledTasks.uuid, taskId))
                .limit(1);

            // Update in BullMQ scheduler (only if scheduler is running)
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();

                if (scheduler.isSchedulerRunning()) {
                    if (updatedTask.length > 0) {
                        await scheduler.addScheduledTask(updatedTask[0]);
                    }
                } else {
                    // Scheduler runs in a separate worker process - it will pick up the task via polling
                    log.debug(`Task updated in database. Scheduler worker will sync via polling.`);
                }
            } catch (error) {
                log.warning(`Failed to update task in scheduler: ${error}`);
            }

            // Convert to snake_case and return the updated task
            const serialized = serializeRecord(updatedTask[0]);
            const icon = TASK_TYPE_ICONS[updatedTask[0].taskType] || "Calendar";

            res.json({
                success: true,
                data: {
                    ...serialized,
                    icon,
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Pause a scheduled task
     */
    public pause = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const { reason } = req.body;

            const db = await getDB();

            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            await db
                .update(schemas.scheduledTasks)
                .set({
                    isPaused: true,
                    pauseReason: reason || "Paused by user",
                    updatedAt: new Date(),
                })
                .where(whereClause);

            // Remove from BullMQ scheduler
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                await SchedulerManager.getInstance().removeScheduledTask(taskId!);
            } catch (error) {
                log.warning(`Failed to remove task from scheduler: ${error}`);
            }

            // Trigger webhook for task pause
            try {
                if (process.env.ANYCRAWL_WEBHOOKS_ENABLED === "true") {
                    const pausedTask = await db
                        .select()
                        .from(schemas.scheduledTasks)
                        .where(eq(schemas.scheduledTasks.uuid, taskId))
                        .limit(1);

                    if (pausedTask[0]) {
                        const { WebhookManager } = await import("@anycrawl/scrape");
                        await WebhookManager.getInstance().triggerEvent(
                            WebhookEventType.TASK_PAUSED,
                            {
                                task_id: taskId,
                                task_name: pausedTask[0].name,
                                task_type: pausedTask[0].taskType,
                                status: "paused",
                                reason: reason || "Paused by user",
                            },
                            "task",
                            taskId!,
                            pausedTask[0].userId ?? undefined
                        );
                    }
                }
            } catch (e) {
                log.warning(`Failed to trigger webhook for task pause: ${e}`);
            }

            res.json({
                success: true,
                message: "Task paused successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Resume a paused task
     */
    public resume = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const db = await getDB();

            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            await db
                .update(schemas.scheduledTasks)
                .set({
                    isPaused: false,
                    pauseReason: null,
                    consecutiveFailures: 0,
                    updatedAt: new Date(),
                })
                .where(whereClause);

            // Add back to BullMQ scheduler (only if scheduler is running)
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();

                if (scheduler.isSchedulerRunning()) {
                    const resumedTask = await db
                        .select()
                        .from(schemas.scheduledTasks)
                        .where(eq(schemas.scheduledTasks.uuid, taskId))
                        .limit(1);

                    if (resumedTask.length > 0) {
                        await scheduler.addScheduledTask(resumedTask[0]);
                    }
                } else {
                    // Scheduler runs in a separate worker process - it will pick up the task via polling
                    log.debug(`Task resumed in database. Scheduler worker will sync via polling.`);
                }
            } catch (error) {
                log.warning(`Failed to add task to scheduler: ${error}`);
            }

            // Trigger webhook for task resume
            try {
                if (process.env.ANYCRAWL_WEBHOOKS_ENABLED === "true") {
                    const resumedTask = await db
                        .select()
                        .from(schemas.scheduledTasks)
                        .where(eq(schemas.scheduledTasks.uuid, taskId))
                        .limit(1);

                    if (resumedTask[0]) {
                        const { WebhookManager } = await import("@anycrawl/scrape");
                        await WebhookManager.getInstance().triggerEvent(
                            WebhookEventType.TASK_RESUMED,
                            {
                                task_id: taskId,
                                task_name: resumedTask[0].name,
                                task_type: resumedTask[0].taskType,
                                status: "resumed",
                            },
                            "task",
                            taskId!,
                            resumedTask[0].userId ?? undefined
                        );
                    }
                }
            } catch (e) {
                log.warning(`Failed to trigger webhook for task resume: ${e}`);
            }

            res.json({
                success: true,
                message: "Task resumed successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Delete a scheduled task
     */
    public delete = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;

            if (!taskId) {
                res.status(400).json({
                    success: false,
                    error: "Task ID is required",
                });
                return;
            }

            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const db = await getDB();

            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            await db
                .delete(schemas.scheduledTasks)
                .where(whereClause);

            // Remove webhook associations
            await this.removeWebhookAssociations(taskId);

            // Remove from BullMQ scheduler
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                await SchedulerManager.getInstance().removeScheduledTask(taskId!);
            } catch (error) {
                log.warning(`Failed to remove task from scheduler: ${error}`);
            }

            res.json({
                success: true,
                message: "Task deleted successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Cancel a single execution
     *
     * DELETE /v1/scheduled-tasks/:taskId/executions/:executionId
     */
    public cancelExecution = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId, executionId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const db = await getDB();

            // Verify task belongs to user/apiKey
            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            const task = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(whereClause)
                .limit(1);

            if (!task.length) {
                res.status(404).json({
                    success: false,
                    error: "Task not found",
                });
                return;
            }

            // Verify execution belongs to this task
            const execution = await db
                .select()
                .from(schemas.taskExecutions)
                .where(
                    sql`${schemas.taskExecutions.uuid} = ${executionId}
                        AND ${schemas.taskExecutions.scheduledTaskUuid} = ${taskId}`
                )
                .limit(1);

            if (!execution.length) {
                res.status(404).json({
                    success: false,
                    error: "Execution not found",
                });
                return;
            }

            // Cancel the execution
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const result = await SchedulerManager.getInstance().cancelExecution(executionId!);

                if (result.success) {
                    res.json({
                        success: true,
                        message: result.message,
                    });
                } else {
                    res.status(400).json({
                        success: false,
                        error: result.message,
                    });
                }
            } catch (error) {
                log.error(`Failed to cancel execution: ${error}`);
                res.status(500).json({
                    success: false,
                    error: "Failed to cancel execution",
                    message: error instanceof Error ? error.message : "Unknown error",
                });
            }
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get execution history for a task
     */
    public executions = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const limit = parseInt(req.query.limit as string) || 100;
            const offset = parseInt(req.query.offset as string) || 0;

            const db = await getDB();

            // Verify task belongs to user/apiKey, or just check existence if no auth
            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            const task = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(whereClause)
                .limit(1);

            if (!task.length) {
                res.status(404).json({
                    success: false,
                    error: "Task not found",
                });
                return;
            }

            // Query executions with job metrics via LEFT JOIN
            const executions = await db
                .select({
                    // Execution fields
                    uuid: schemas.taskExecutions.uuid,
                    scheduledTaskUuid: schemas.taskExecutions.scheduledTaskUuid,
                    executionNumber: schemas.taskExecutions.executionNumber,
                    idempotencyKey: schemas.taskExecutions.idempotencyKey,
                    status: schemas.taskExecutions.status,
                    startedAt: schemas.taskExecutions.startedAt,
                    completedAt: schemas.taskExecutions.completedAt,
                    jobUuid: schemas.taskExecutions.jobUuid,
                    errorMessage: schemas.taskExecutions.errorMessage,
                    errorCode: schemas.taskExecutions.errorCode,
                    errorDetails: schemas.taskExecutions.errorDetails,
                    triggeredBy: schemas.taskExecutions.triggeredBy,
                    scheduledFor: schemas.taskExecutions.scheduledFor,
                    metadata: schemas.taskExecutions.metadata,
                    createdAt: schemas.taskExecutions.createdAt,
                    // Job metrics (from jobs table)
                    creditsUsed: schemas.jobs.creditsUsed,
                    itemsProcessed: schemas.jobs.total,
                    itemsSucceeded: schemas.jobs.completed,
                    itemsFailed: schemas.jobs.failed,
                    jobStatus: schemas.jobs.status,
                    jobSuccess: schemas.jobs.isSuccess,
                })
                .from(schemas.taskExecutions)
                .leftJoin(schemas.jobs, eq(schemas.taskExecutions.jobUuid, schemas.jobs.uuid))
                .where(eq(schemas.taskExecutions.scheduledTaskUuid, taskId))
                .orderBy(sql`${schemas.taskExecutions.createdAt} DESC`)
                .limit(limit)
                .offset(offset);

            // Calculate duration_ms for each execution
            const executionsWithDuration = executions.map((exec: any) => ({
                ...exec,
                durationMs: exec.startedAt && exec.completedAt
                    ? exec.completedAt.getTime() - exec.startedAt.getTime()
                    : null,
            }));

            // Convert to snake_case
            const serialized = serializeRecords(executionsWithDuration);

            // Add icon to each execution based on status
            const serializedWithIcons = serialized.map((execution: any) => ({
                ...execution,
                icon: EXECUTION_STATUS_ICONS[execution.status] || "Clock",
            }));

            res.json({
                success: true,
                data: serializedWithIcons,
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    private calculateNextExecution(cronExpression: string, timezone: string): Date | null {
        try {
            const interval = CronExpressionParser.parse(cronExpression, {
                tz: timezone || "UTC",
                currentDate: new Date(),
            });
            return interval.next().toDate();
        } catch (error) {
            log.error(`Failed to calculate next execution: ${error}`);
            return null;
        }
    }

    /**
     * Handle webhook associations when creating/updating a task
     */
    private async handleWebhookAssociations(
        taskId: string,
        webhookIds?: string[],
        webhookUrl?: string,
        apiKeyId?: string,
        userId?: string
    ): Promise<void> {
        const db = await getDB();

        // Option 1: Create a new webhook for this task
        if (webhookUrl) {
            try {
                const webhookUuid = randomUUID();
                const secret = crypto.randomBytes(32).toString("hex");

                await db.insert(schemas.webhookSubscriptions).values({
                    uuid: webhookUuid,
                    apiKey: apiKeyId,
                    userId: userId || null,
                    name: `Webhook for task: ${taskId}`,
                    description: `Auto-created webhook for scheduled task`,
                    webhookUrl: webhookUrl,
                    webhookSecret: secret,
                    scope: "specific",
                    specificTaskIds: [taskId],
                    eventTypes: ["task.executed", "task.failed", "task.paused", "task.resumed"],
                    isActive: true,
                    customHeaders: {},
                    timeoutSeconds: 10,
                    maxRetries: 3,
                    retryBackoffMultiplier: 2,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });

                log.info(`Auto-created webhook ${webhookUuid} for task ${taskId}`);
            } catch (error) {
                log.error(`Failed to create webhook for task ${taskId}: ${error}`);
            }
        }

        // Option 2: Associate with existing webhooks
        if (webhookIds && webhookIds.length > 0) {
            for (const webhookId of webhookIds) {
                try {
                    // Verify webhook exists and belongs to user
                    const whereClause = userId
                        ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${userId}`
                        : apiKeyId
                        ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${apiKeyId}`
                        : sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;

                    const webhook = await db
                        .select()
                        .from(schemas.webhookSubscriptions)
                        .where(whereClause)
                        .limit(1);

                    if (!webhook.length) {
                        log.warning(`Webhook ${webhookId} not found or not owned by user`);
                        continue;
                    }

                    // Update webhook to include this task
                    const currentTaskIds = (webhook[0].specificTaskIds as string[]) || [];
                    if (!currentTaskIds.includes(taskId)) {
                        const updatedTaskIds = [...currentTaskIds, taskId];
                        await db
                            .update(schemas.webhookSubscriptions)
                            .set({
                                specificTaskIds: updatedTaskIds,
                                scope: "specific",
                                updatedAt: new Date(),
                            })
                            .where(eq(schemas.webhookSubscriptions.uuid, webhookId));

                        log.info(`Associated webhook ${webhookId} with task ${taskId}`);
                    }
                } catch (error) {
                    log.error(`Failed to associate webhook ${webhookId} with task ${taskId}: ${error}`);
                }
            }
        }
    }

    /**
     * Remove task from all webhook associations
     */
    private async removeWebhookAssociations(taskId: string): Promise<void> {
        const db = await getDB();

        try {
            // Find all webhooks that reference this task
            const webhooks = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(sql`${schemas.webhookSubscriptions.specificTaskIds}::jsonb @> ${JSON.stringify([taskId])}`);

            for (const webhook of webhooks) {
                const currentTaskIds = (webhook.specificTaskIds as string[]) || [];
                const updatedTaskIds = currentTaskIds.filter((id) => id !== taskId);

                // Update with remaining tasks (keep as empty array if no tasks left)
                await db
                    .update(schemas.webhookSubscriptions)
                    .set({
                        specificTaskIds: updatedTaskIds.length > 0 ? updatedTaskIds : [],
                        updatedAt: new Date(),
                    })
                    .where(eq(schemas.webhookSubscriptions.uuid, webhook.uuid));

                log.info(`Removed task ${taskId} from webhook ${webhook.uuid}`);
            }
        } catch (error) {
            log.error(`Failed to remove webhook associations for task ${taskId}: ${error}`);
        }
    }

    private handleError(error: any, res: Response): void {
        if (error instanceof z.ZodError) {
            const formattedErrors = error.errors.map((err) => ({
                field: err.path.join("."),
                message: err.message,
                code: err.code,
            }));
            const message = error.errors.map((err) => err.message).join(", ");
            res.status(400).json({
                success: false,
                error: "Validation error",
                message: message,
                details: formattedErrors,
            });
        } else {
            log.error(`Scheduled tasks controller error: ${error}`);
            res.status(500).json({
                success: false,
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
}
