import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
    SchedulerManager,
    buildScheduledExecutionIdempotencyKey,
    resolveDispatchStateFromError,
    resolveScheduledFor,
} from "../../managers/Scheduler.js";

function createCleanupDbStub(
    runningExecutions: Array<Record<string, unknown>>,
    transitionRows: Array<Record<string, unknown>>
) {
    const select = jest
        .fn()
        .mockImplementationOnce(() => ({
            from: () => ({
                where: async () => [],
            }),
        }))
        .mockImplementationOnce(() => ({
            from: () => ({
                innerJoin: () => ({
                    leftJoin: () => ({
                        where: async () => runningExecutions,
                    }),
                }),
            }),
        }));

    const updateResults = [transitionRows];
    const update = jest.fn(() => ({
        set: () => ({
            where: () => ({
                returning: async () => updateResults.shift() ?? [],
            }),
        }),
    }));

    const db = {
        select,
        update,
    };

    return { db, update };
}

describe("Scheduler lifecycle guards", () => {
    const originalCreditsEnabled = process.env.ANYCRAWL_API_CREDITS_ENABLED;

    beforeEach(() => {
        process.env.ANYCRAWL_API_CREDITS_ENABLED = "false";
    });

    afterEach(() => {
        if (originalCreditsEnabled === undefined) {
            delete process.env.ANYCRAWL_API_CREDITS_ENABLED;
        } else {
            process.env.ANYCRAWL_API_CREDITS_ENABLED = originalCreditsEnabled;
        }
        jest.restoreAllMocks();
    });

    it("recognizes dispatch-committed errors and preserves job UUID from error payload", () => {
        const error = Object.assign(new Error("post-dispatch failure"), {
            dispatchCommitted: true,
            jobUuid: "job-from-error",
        });

        const state = resolveDispatchStateFromError(false, undefined, error);
        expect(state.executionDispatched).toBe(true);
        expect(state.jobUuid).toBe("job-from-error");
    });

    it("uses nextExecutionAt as scheduledFor when it is available", () => {
        const scheduledFor = new Date("2026-05-28T01:00:00.000Z");
        const fallback = new Date("2026-05-28T02:00:00.000Z");

        expect(resolveScheduledFor(scheduledFor, fallback)).toBe(scheduledFor);
        expect(resolveScheduledFor(scheduledFor.toISOString(), fallback)).toEqual(scheduledFor);
    });

    it("builds stable idempotency keys from task UUID and scheduled time", () => {
        const scheduledFor = new Date("2026-05-28T01:00:00.000Z");

        expect(buildScheduledExecutionIdempotencyKey("task-1", scheduledFor)).toBe(
            "task-1-2026-05-28T01:00:00.000Z"
        );
    });

    it("skips timed-out job status update when finalizeExecution does not transition", async () => {
        const startedAt = new Date(Date.now() - 31 * 60 * 1000);
        const runningExecution = {
            executionUuid: "exec-no-transition",
            scheduledTaskUuid: "task-1",
            jobUuid: "job-1",
            startedAt,
            taskType: "scrape",
            jobType: "scrape",
            jobUpdatedAt: startedAt,
        };
        const { db, update } = createCleanupDbStub([runningExecution], []);

        const manager = SchedulerManager.getInstance();
        await (manager as any).cleanupStaleRunningExecutions(db);

        // finalizeExecution attempted one status transition update;
        // no scheduled_task/job update should happen when transitioned=false.
        expect(update).toHaveBeenCalledTimes(1);
    });

    it("updates timed-out job status when finalizeExecution transitions", async () => {
        const startedAt = new Date(Date.now() - 31 * 60 * 1000);
        const runningExecution = {
            executionUuid: "exec-transition",
            scheduledTaskUuid: "task-1",
            jobUuid: "job-2",
            startedAt,
            taskType: "scrape",
            jobType: "scrape",
            jobUpdatedAt: startedAt,
        };
        const { db, update } = createCleanupDbStub(
            [runningExecution],
            [{ uuid: runningExecution.executionUuid, scheduledTaskUuid: runningExecution.scheduledTaskUuid }]
        );

        const manager = SchedulerManager.getInstance();
        await (manager as any).cleanupStaleRunningExecutions(db);

        // taskExecutions transition + scheduledTasks stats + jobs status update
        expect(update).toHaveBeenCalledTimes(3);
    });
});
