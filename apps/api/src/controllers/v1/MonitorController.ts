import { Response } from "express";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import {
    RequestWithAuth,
    type OwnerContext,
    createMonitorSchema,
    updateMonitorSchema,
    resolveTrackMode,
    estimateTaskCredits,
    normalizePagination,
    log,
} from "@anycrawl/libs";
import {
    getDB,
    schemas,
    eq,
    sql,
    getOwnedMonitor,
    listMonitorsByOwner,
    listSnapshotsByMonitor,
    listChangesByMonitor,
} from "@anycrawl/db";
import { randomUUID } from "crypto";
import { serializeRecord, serializeRecords } from "../../utils/serializer.js";

/**
 * Build the underlying scrape task_payload from a monitor's first target.
 * Price/json monitors add json_options + the json format so the scrape worker
 * runs LLM extraction as part of the same job.
 */
function buildTaskPayload(
    target: any,
    monitorType: string,
    trackMode: string,
    extractSchema: any,
    goal: string | undefined,
    diffOptions: any
): any {
    const formats = trackMode === "text" ? ["markdown"] : ["markdown", "json"];
    const options: any = {
        formats,
        only_main_content: diffOptions?.only_main_content ?? true,
        ...(target.options ?? {}),
    };
    if ((trackMode === "json" || trackMode === "mixed") && extractSchema) {
        options.json_options = {
            schema: extractSchema,
            ...(goal ? { user_prompt: goal } : {}),
        };
    }
    return {
        url: target.url,
        engine: target.engine ?? "auto",
        options,
    };
}

export class MonitorController {
    /**
     * Create a monitor. Creates a backing scheduled_task (1:1) and a monitors row.
     */
    public create = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const validated = createMonitorSchema.parse(req.body);
            const owner = this.getOwnerContext(req);
            const { apiKeyId, userId } = owner;

            // MVP: single target. Additional targets are accepted but only the first is scheduled.
            const target = validated.targets[0];
            const trackMode = resolveTrackMode(validated.monitor_type, validated.track_mode);
            const taskPayload = buildTaskPayload(
                target,
                validated.monitor_type,
                trackMode,
                validated.extract_schema,
                validated.goal,
                validated.diff_options
            );

            const minCreditsRequired = estimateTaskCredits("scrape", taskPayload);
            const nextExecution = this.calculateNextExecution(
                validated.cron_expression,
                validated.timezone
            );

            const db = await getDB();
            const scheduledTaskUuid = randomUUID();
            const monitorUuid = randomUUID();

            // 1. Backing scheduled task
            await db.insert(schemas.scheduledTasks).values({
                uuid: scheduledTaskUuid,
                apiKey: apiKeyId,
                userId: userId || null,
                name: `[monitor] ${validated.name}`,
                description: validated.description,
                cronExpression: validated.cron_expression,
                timezone: validated.timezone,
                taskType: "scrape",
                taskPayload,
                concurrencyMode: validated.concurrency_mode,
                maxExecutionsPerDay: validated.max_executions_per_day,
                minCreditsRequired,
                isActive: true,
                isPaused: false,
                nextExecutionAt: nextExecution,
                tags: validated.tags,
                metadata: { ...(validated.metadata ?? {}), monitorManaged: true, monitorUuid },
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            // 2. Monitor row
            await db.insert(schemas.monitors).values({
                uuid: monitorUuid,
                apiKey: apiKeyId,
                userId: userId || null,
                name: validated.name,
                description: validated.description,
                monitorType: validated.monitor_type,
                scheduledTaskUuid,
                targets: validated.targets,
                goal: validated.goal,
                trackMode,
                extractSchema: validated.extract_schema ?? null,
                diffOptions: validated.diff_options ?? null,
                notifyOptions: validated.notify_options ?? { channels: ["webhook"], only_meaningful: true },
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            // 3. Register with the scheduler if it's running
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();
                if (scheduler.isSchedulerRunning()) {
                    const createdTask = await db
                        .select()
                        .from(schemas.scheduledTasks)
                        .where(eq(schemas.scheduledTasks.uuid, scheduledTaskUuid))
                        .limit(1);
                    if (createdTask.length > 0) {
                        await scheduler.addScheduledTask(createdTask[0]);
                    }
                } else {
                    log.debug("Monitor created. Scheduler worker will sync via polling.");
                }
            } catch (error) {
                log.warning(`Failed to add monitor task to scheduler: ${error}`);
            }

            res.status(201).json({
                success: true,
                data: {
                    monitor_id: monitorUuid,
                    scheduled_task_id: scheduledTaskUuid,
                    track_mode: trackMode,
                    next_execution_at: nextExecution?.toISOString(),
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * List monitors for the authenticated owner
     */
    public list = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const monitors = await listMonitorsByOwner(db, owner);
            res.json({ success: true, data: serializeRecords(monitors) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get one monitor
     */
    public get = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id } = req.params;
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }
            res.json({ success: true, data: serializeRecord(monitor) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Update a monitor. Propagates cron/payload-affecting changes to the backing task.
     */
    public update = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id } = req.params;
            const owner = this.getOwnerContext(req);
            const validated = updateMonitorSchema.parse(req.body);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            const monitorUpdate: any = { updatedAt: new Date() };
            if (validated.name !== undefined) monitorUpdate.name = validated.name;
            if (validated.description !== undefined) monitorUpdate.description = validated.description;
            if (validated.goal !== undefined) monitorUpdate.goal = validated.goal;
            if (validated.targets !== undefined) monitorUpdate.targets = validated.targets;
            if (validated.extract_schema !== undefined) monitorUpdate.extractSchema = validated.extract_schema;
            if (validated.diff_options !== undefined) monitorUpdate.diffOptions = validated.diff_options;
            if (validated.notify_options !== undefined) monitorUpdate.notifyOptions = validated.notify_options;
            if (validated.is_active !== undefined) monitorUpdate.isActive = validated.is_active;
            const newTrackMode = validated.track_mode ?? monitor.trackMode;
            if (validated.track_mode !== undefined) monitorUpdate.trackMode = validated.track_mode;

            await db.update(schemas.monitors).set(monitorUpdate).where(eq(schemas.monitors.uuid, id));

            // Propagate to backing scheduled task when scheduling/payload inputs changed
            const taskUpdate: any = { updatedAt: new Date() };
            let taskChanged = false;
            if (validated.cron_expression) {
                taskUpdate.cronExpression = validated.cron_expression;
                taskUpdate.nextExecutionAt = this.calculateNextExecution(
                    validated.cron_expression,
                    validated.timezone || monitor.timezone || "UTC"
                );
                taskChanged = true;
            }
            if (validated.timezone) { taskUpdate.timezone = validated.timezone; taskChanged = true; }
            if (validated.concurrency_mode) { taskUpdate.concurrencyMode = validated.concurrency_mode; taskChanged = true; }
            if (validated.max_executions_per_day !== undefined) { taskUpdate.maxExecutionsPerDay = validated.max_executions_per_day; taskChanged = true; }
            if (validated.targets || validated.extract_schema !== undefined || validated.goal !== undefined || validated.track_mode !== undefined || validated.diff_options !== undefined) {
                const target = (validated.targets ?? monitor.targets)[0];
                taskUpdate.taskPayload = buildTaskPayload(
                    target,
                    monitor.monitorType,
                    newTrackMode,
                    validated.extract_schema ?? monitor.extractSchema,
                    validated.goal ?? monitor.goal,
                    validated.diff_options ?? monitor.diffOptions
                );
                taskChanged = true;
            }

            if (monitor.scheduledTaskUuid && taskChanged) {
                await db.update(schemas.scheduledTasks).set(taskUpdate).where(eq(schemas.scheduledTasks.uuid, monitor.scheduledTaskUuid));
                try {
                    const { SchedulerManager } = await import("@anycrawl/scrape");
                    const scheduler = SchedulerManager.getInstance();
                    if (scheduler.isSchedulerRunning()) {
                        const updatedTask = await db
                            .select()
                            .from(schemas.scheduledTasks)
                            .where(eq(schemas.scheduledTasks.uuid, monitor.scheduledTaskUuid))
                            .limit(1);
                        if (updatedTask.length > 0) await scheduler.addScheduledTask(updatedTask[0]);
                    }
                } catch (error) {
                    log.warning(`Failed to update monitor task in scheduler: ${error}`);
                }
            }

            const updated = await getOwnedMonitor(db, id!, owner);
            res.json({ success: true, data: serializeRecord(updated) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Delete a monitor and its backing scheduled task (cascade removes snapshots/changes).
     */
    public delete = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id } = req.params;
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            // Deleting the monitor first (FK cascade removes snapshots + changes)
            await db.delete(schemas.monitors).where(eq(schemas.monitors.uuid, id));

            // Then remove the backing scheduled task
            if (monitor.scheduledTaskUuid) {
                await db.delete(schemas.scheduledTasks).where(eq(schemas.scheduledTasks.uuid, monitor.scheduledTaskUuid));
                try {
                    const { SchedulerManager } = await import("@anycrawl/scrape");
                    await SchedulerManager.getInstance().removeScheduledTask(monitor.scheduledTaskUuid);
                } catch (error) {
                    log.warning(`Failed to remove monitor task from scheduler: ${error}`);
                }
            }

            res.json({ success: true, message: "Monitor deleted successfully" });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Pause monitoring (pauses the backing scheduled task).
     */
    public pause = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id } = req.params;
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            await db.update(schemas.monitors).set({ isActive: false, updatedAt: new Date() }).where(eq(schemas.monitors.uuid, id));
            if (monitor.scheduledTaskUuid) {
                await db.update(schemas.scheduledTasks)
                    .set({ isPaused: true, pauseReason: "Paused by user (monitor)", updatedAt: new Date() })
                    .where(eq(schemas.scheduledTasks.uuid, monitor.scheduledTaskUuid));
                try {
                    const { SchedulerManager } = await import("@anycrawl/scrape");
                    await SchedulerManager.getInstance().removeScheduledTask(monitor.scheduledTaskUuid);
                } catch (error) {
                    log.warning(`Failed to pause monitor task: ${error}`);
                }
            }
            res.json({ success: true, message: "Monitor paused successfully" });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Resume monitoring.
     */
    public resume = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id } = req.params;
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            await db.update(schemas.monitors).set({ isActive: true, updatedAt: new Date() }).where(eq(schemas.monitors.uuid, id));
            if (monitor.scheduledTaskUuid) {
                await db.update(schemas.scheduledTasks)
                    .set({ isPaused: false, pauseReason: null, consecutiveFailures: 0, updatedAt: new Date() })
                    .where(eq(schemas.scheduledTasks.uuid, monitor.scheduledTaskUuid));
                try {
                    const { SchedulerManager } = await import("@anycrawl/scrape");
                    const scheduler = SchedulerManager.getInstance();
                    if (scheduler.isSchedulerRunning()) {
                        const resumedTask = await db
                            .select()
                            .from(schemas.scheduledTasks)
                            .where(eq(schemas.scheduledTasks.uuid, monitor.scheduledTaskUuid))
                            .limit(1);
                        if (resumedTask.length > 0) await scheduler.addScheduledTask(resumedTask[0]);
                    }
                } catch (error) {
                    log.warning(`Failed to resume monitor task: ${error}`);
                }
            }
            res.json({ success: true, message: "Monitor resumed successfully" });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Trigger an immediate check (on-demand run).
     */
    public check = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id } = req.params;
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }
            if (!monitor.scheduledTaskUuid) {
                res.status(400).json({ success: false, error: "Monitor has no backing scheduled task" });
                return;
            }

            const taskRows = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(eq(schemas.scheduledTasks.uuid, monitor.scheduledTaskUuid))
                .limit(1);
            if (!taskRows.length) {
                res.status(404).json({ success: false, error: "Backing task not found" });
                return;
            }

            // Dedup guard: reject if a run is already pending/running for this monitor's
            // task. Prevents a client from flooding the queue via repeated /check calls.
            const inFlight = await db
                .select({ uuid: schemas.taskExecutions.uuid })
                .from(schemas.taskExecutions)
                .where(
                    sql`${schemas.taskExecutions.scheduledTaskUuid} = ${monitor.scheduledTaskUuid}
                        AND ${schemas.taskExecutions.status} IN ('pending', 'running')`
                )
                .limit(1);
            if (inFlight.length > 0) {
                res.status(409).json({
                    success: false,
                    error: "A check is already in progress for this monitor",
                });
                return;
            }

            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();
                if (!scheduler.isSchedulerRunning()) {
                    res.status(503).json({ success: false, error: "Scheduler is not running; cannot trigger on-demand check" });
                    return;
                }
                await scheduler.triggerTaskNow(taskRows[0]);
            } catch (error) {
                log.warning(`Failed to trigger monitor check: ${error}`);
                res.status(500).json({ success: false, error: "Failed to trigger check" });
                return;
            }

            res.status(202).json({ success: true, message: "Check triggered", data: { monitor_id: id } });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * List snapshots for a monitor (paginated).
     */
    public snapshots = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id } = req.params;
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            const { limit, offset } = normalizePagination(
                req.query.limit as string | undefined,
                req.query.offset as string | undefined,
                { defaultLimit: 50, maxLimit: 200 }
            );
            const rows = await listSnapshotsByMonitor(db, id!, offset, limit);
            res.json({ success: true, data: serializeRecords(rows) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * List detected changes for a monitor (paginated). Doubles as price-history source.
     */
    public changes = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id } = req.params;
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            const { limit, offset } = normalizePagination(
                req.query.limit as string | undefined,
                req.query.offset as string | undefined,
                { defaultLimit: 50, maxLimit: 200 }
            );
            const rows = await listChangesByMonitor(db, id!, offset, limit);
            res.json({ success: true, data: serializeRecords(rows) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get a single change record with full diff.
     */
    public changeDetail = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id, changeId } = req.params;
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            const rows = await db
                .select()
                .from(schemas.monitorChanges)
                .where(
                    sql`${schemas.monitorChanges.uuid} = ${changeId}
                        AND ${schemas.monitorChanges.monitorUuid} = ${id}`
                )
                .limit(1);
            if (!rows.length) {
                res.status(404).json({ success: false, error: "Change not found" });
                return;
            }
            res.json({ success: true, data: serializeRecord(rows[0]) });
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
                message,
                details: formattedErrors,
            });
        } else {
            log.error(`Monitor controller error: ${error}`);
            res.status(500).json({
                success: false,
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
}
