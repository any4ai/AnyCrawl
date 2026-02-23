import { log } from "crawlee";
import { getDB, schemas, eq, sql } from "@anycrawl/db";

type FinalExecutionStatus = "completed" | "failed" | "cancelled";

type MissingExecutionPayload = {
    scheduledTaskUuid: string;
    executionNumber: number;
    idempotencyKey: string;
    scheduledFor?: Date;
    triggeredBy?: string;
    createdAt?: Date;
    jobUuid?: string;
};

export type FinalizeExecutionInput = {
    db?: any;
    executionUuid: string;
    status: FinalExecutionStatus;
    jobUuid?: string;
    startedAt?: Date;
    completedAt?: Date;
    errorMessage?: string;
    errorCode?: string;
    errorDetails?: any;
    updateTaskStats?: boolean;
    allowCreateIfMissing?: boolean;
    createIfMissing?: MissingExecutionPayload;
    source?: "scheduler" | "worker" | "cleanup" | "system";
};

export type FinalizeExecutionResult = {
    transitioned: boolean;
    created: boolean;
    taskStatsUpdated: boolean;
    scheduledTaskUuid?: string;
};

/**
 * Finalize an execution in an idempotent way:
 * - Only transitions pending/running executions into terminal states once
 * - Updates scheduled_tasks counters consistently on real transitions
 * - Optionally recreates a failed record when transaction rollback removed it
 */
export async function finalizeExecution(input: FinalizeExecutionInput): Promise<FinalizeExecutionResult> {
    const db = input.db || await getDB();
    const completedAt = input.completedAt || new Date();
    const now = new Date();

    const updateData: any = {
        status: input.status,
        completedAt,
    };

    if (input.startedAt) {
        updateData.startedAt = input.startedAt;
    }

    if (input.jobUuid) {
        updateData.jobUuid = input.jobUuid;
    }

    if (input.errorMessage !== undefined) {
        updateData.errorMessage = input.errorMessage;
    }

    if (input.errorCode !== undefined) {
        updateData.errorCode = input.errorCode;
    }

    if (input.errorDetails !== undefined) {
        updateData.errorDetails = input.errorDetails;
    }

    const updatedRows = await db
        .update(schemas.taskExecutions)
        .set(updateData)
        .where(
            sql`${schemas.taskExecutions.uuid} = ${input.executionUuid}
                AND ${schemas.taskExecutions.status} IN ('pending', 'running')`
        )
        .returning({
            uuid: schemas.taskExecutions.uuid,
            scheduledTaskUuid: schemas.taskExecutions.scheduledTaskUuid,
        });

    let transitioned = updatedRows.length > 0;
    let created = false;
    let scheduledTaskUuid = updatedRows[0]?.scheduledTaskUuid as string | undefined;

    if (
        !transitioned
        && input.allowCreateIfMissing
        && input.status === "failed"
        && input.createIfMissing
    ) {
        try {
            await db.insert(schemas.taskExecutions).values({
                uuid: input.executionUuid,
                scheduledTaskUuid: input.createIfMissing.scheduledTaskUuid,
                executionNumber: input.createIfMissing.executionNumber,
                idempotencyKey: input.createIfMissing.idempotencyKey,
                status: "failed",
                scheduledFor: input.createIfMissing.scheduledFor || now,
                triggeredBy: input.createIfMissing.triggeredBy || "scheduler",
                createdAt: input.createIfMissing.createdAt || now,
                startedAt: input.startedAt,
                completedAt: completedAt,
                jobUuid: input.createIfMissing.jobUuid,
                errorMessage: input.errorMessage,
                errorCode: input.errorCode,
                errorDetails: {
                    ...(input.errorDetails || {}),
                    recoveredFromRollback: true,
                },
            });
            transitioned = true;
            created = true;
            scheduledTaskUuid = input.createIfMissing.scheduledTaskUuid;
        } catch (error) {
            // Best effort: another process may have finalized first.
            log.warning(
                `[EXECUTION] Failed to recreate missing execution ${input.executionUuid} from ${input.source || "system"}: ${error}`
            );
        }
    }

    let taskStatsUpdated = false;
    const shouldUpdateTaskStats = input.updateTaskStats !== false;

    if (shouldUpdateTaskStats && transitioned && scheduledTaskUuid) {
        if (input.status === "completed") {
            await db
                .update(schemas.scheduledTasks)
                .set({
                    successfulExecutions: sql`${schemas.scheduledTasks.successfulExecutions} + 1`,
                    consecutiveFailures: 0,
                    updatedAt: now,
                })
                .where(eq(schemas.scheduledTasks.uuid, scheduledTaskUuid));
            taskStatsUpdated = true;
        } else if (input.status === "failed") {
            await db
                .update(schemas.scheduledTasks)
                .set({
                    failedExecutions: sql`${schemas.scheduledTasks.failedExecutions} + 1`,
                    consecutiveFailures: sql`${schemas.scheduledTasks.consecutiveFailures} + 1`,
                    updatedAt: now,
                })
                .where(eq(schemas.scheduledTasks.uuid, scheduledTaskUuid));
            taskStatsUpdated = true;
        }
    }

    return {
        transitioned,
        created,
        taskStatsUpdated,
        scheduledTaskUuid,
    };
}
