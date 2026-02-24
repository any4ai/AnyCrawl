import { Response } from "express";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import {
    RequestWithAuth,
    type OwnerContext,
    createTaskSchema,
    updateTaskSchema,
    estimateTaskCredits,
    WebhookEventType,
    isScheduledTasksLimitEnabled,
    getScheduledTasksLimit,
    buildLimitExceededResponse,
    normalizePagination,
    log,
} from "@anycrawl/libs";
import {
    getDB,
    schemas,
    eq,
    sql,
    buildTaskWhereClause,
    getOwnedTask,
    listTasksByOwner,
} from "@anycrawl/db";
import { randomUUID } from "crypto";
import { serializeRecord, serializeRecords } from "../../utils/serializer.js";
import { handleWebhookAssociations, removeWebhookAssociations } from "./scheduled-tasks/webhookAssociations.js";

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
            const owner = this.getOwnerContext(req);
            const { apiKeyId, userId } = owner;

            if (isScheduledTasksLimitEnabled() && apiKeyId) {
                const db = await getDB();

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

            let template = null;
            if (validatedData.task_payload.template_id) {
                try {
                    const { getTemplate } = await import("@anycrawl/db");
                    template = await getTemplate(String(validatedData.task_payload.template_id));
                } catch (error) {
                    log.warning(`Failed to fetch template for credit calculation: ${error}`);
                }
            }

            const minCreditsRequired = estimateTaskCredits(
                validatedData.task_type,
                validatedData.task_payload,
                template ? { template } : undefined
            );

            const nextExecution = this.calculateNextExecution(
                validatedData.cron_expression,
                validatedData.timezone
            );

            const db = await getDB();
            const taskUuid = randomUUID();

            await db.insert(schemas.scheduledTasks).values({
                uuid: taskUuid,
                apiKey: apiKeyId,
                userId: userId || null,
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

            await handleWebhookAssociations(
                taskUuid,
                owner,
                validatedData.webhook_ids,
                validatedData.webhook_url
            );

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
                    log.debug("Task created in database. Scheduler worker will sync via polling.");
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
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const tasks = await listTasksByOwner(db, owner);
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
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const task = await getOwnedTask(db, taskId!, owner);

            if (!task) {
                res.status(404).json({
                    success: false,
                    error: "Task not found",
                });
                return;
            }

            const serialized = serializeRecord(task);
            const icon = TASK_TYPE_ICONS[task.taskType] || "Calendar";

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
            const owner = this.getOwnerContext(req);
            const validatedData = updateTaskSchema.parse(req.body);
            const db = await getDB();

            const existing = await getOwnedTask(db, taskId!, owner);
            if (!existing) {
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

            if (validatedData.cron_expression) {
                updateData.cronExpression = validatedData.cron_expression;
                updateData.nextExecutionAt = this.calculateNextExecution(
                    validatedData.cron_expression,
                    validatedData.timezone || existing.timezone
                );
                delete updateData.cron_expression;
            }

            if (validatedData.task_type) updateData.taskType = validatedData.task_type;
            if (validatedData.task_payload) updateData.taskPayload = validatedData.task_payload;
            if (validatedData.concurrency_mode) updateData.concurrencyMode = validatedData.concurrency_mode;
            if (validatedData.max_executions_per_day) updateData.maxExecutionsPerDay = validatedData.max_executions_per_day;

            delete updateData.task_type;
            delete updateData.task_payload;
            delete updateData.concurrency_mode;
            delete updateData.max_executions_per_day;

            await db
                .update(schemas.scheduledTasks)
                .set(updateData)
                .where(eq(schemas.scheduledTasks.uuid, taskId));

            if (validatedData.webhook_ids || validatedData.webhook_url) {
                await handleWebhookAssociations(
                    taskId!,
                    owner,
                    validatedData.webhook_ids,
                    validatedData.webhook_url
                );
            }

            const updatedTask = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(eq(schemas.scheduledTasks.uuid, taskId))
                .limit(1);

            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();

                if (scheduler.isSchedulerRunning()) {
                    if (updatedTask.length > 0) {
                        await scheduler.addScheduledTask(updatedTask[0]);
                    }
                } else {
                    log.debug("Task updated in database. Scheduler worker will sync via polling.");
                }
            } catch (error) {
                log.warning(`Failed to update task in scheduler: ${error}`);
            }

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
            const owner = this.getOwnerContext(req);
            const { reason } = req.body;
            const db = await getDB();

            const whereClause = buildTaskWhereClause(taskId!, owner);

            await db
                .update(schemas.scheduledTasks)
                .set({
                    isPaused: true,
                    pauseReason: reason || "Paused by user",
                    updatedAt: new Date(),
                })
                .where(whereClause);

            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                await SchedulerManager.getInstance().removeScheduledTask(taskId!);
            } catch (error) {
                log.warning(`Failed to remove task from scheduler: ${error}`);
            }

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
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const whereClause = buildTaskWhereClause(taskId!, owner);

            await db
                .update(schemas.scheduledTasks)
                .set({
                    isPaused: false,
                    pauseReason: null,
                    consecutiveFailures: 0,
                    updatedAt: new Date(),
                })
                .where(whereClause);

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
                    log.debug("Task resumed in database. Scheduler worker will sync via polling.");
                }
            } catch (error) {
                log.warning(`Failed to add task to scheduler: ${error}`);
            }

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

            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const whereClause = buildTaskWhereClause(taskId, owner);

            const deletedTasks = await db
                .delete(schemas.scheduledTasks)
                .where(whereClause)
                .returning({ uuid: schemas.scheduledTasks.uuid });

            if (deletedTasks.length > 0) {
                await removeWebhookAssociations(taskId, owner);

                try {
                    const { SchedulerManager } = await import("@anycrawl/scrape");
                    await SchedulerManager.getInstance().removeScheduledTask(taskId);
                } catch (error) {
                    log.warning(`Failed to remove task from scheduler: ${error}`);
                }
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
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const task = await getOwnedTask(db, taskId!, owner);
            if (!task) {
                res.status(404).json({
                    success: false,
                    error: "Task not found",
                });
                return;
            }

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
            const owner = this.getOwnerContext(req);
            const { limit, offset } = normalizePagination(
                req.query.limit as string | undefined,
                req.query.offset as string | undefined
            );
            const db = await getDB();

            const task = await getOwnedTask(db, taskId!, owner);
            if (!task) {
                res.status(404).json({
                    success: false,
                    error: "Task not found",
                });
                return;
            }

            const executions = await db
                .select({
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

            const executionsWithDuration = executions.map((execution: any) => ({
                ...execution,
                durationMs: execution.startedAt && execution.completedAt
                    ? execution.completedAt.getTime() - execution.startedAt.getTime()
                    : null,
            }));

            const serialized = serializeRecords(executionsWithDuration);
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

    private getOwnerContext(req: RequestWithAuth): OwnerContext {
        return {
            apiKeyId: req.auth?.uuid,
            userId: req.auth?.user,
        };
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
