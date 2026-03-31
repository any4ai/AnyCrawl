import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { SchedulerManager, resolveDispatchStateFromError } from "../../managers/Scheduler.js";

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
            [
                {
                    uuid: runningExecution.executionUuid,
                    scheduledTaskUuid: runningExecution.scheduledTaskUuid,
                },
            ]
        );

        const manager = SchedulerManager.getInstance();
        await (manager as any).cleanupStaleRunningExecutions(db);

        // taskExecutions transition + scheduledTasks stats + jobs status update
        expect(update).toHaveBeenCalledTimes(3);
    });
});

describe("Crawl payload normalization", () => {
    function normalizeCrawlPayload(payload: any): any {
        const normalizedPayload = { ...payload };
        if (normalizedPayload.options === undefined) {
            normalizedPayload.options = {};
        }
        if (normalizedPayload.scrape_options && !normalizedPayload.options.scrape_options) {
            normalizedPayload.options.scrape_options = normalizedPayload.scrape_options;
            delete normalizedPayload.scrape_options;
        }
        if (!normalizedPayload.options.scrape_options) {
            normalizedPayload.options.scrape_options = {};
        }
        return normalizedPayload;
    }

    it("normalizes standard nested options", () => {
        const input = {
            url: "https://example.com",
            engine: "playwright",
            options: {
                limit: 10,
                max_depth: 5,
                scrape_options: {
                    formats: ["markdown"],
                },
            },
        };
        const result = normalizeCrawlPayload(input);
        expect(result.options.scrape_options).toEqual({ formats: ["markdown"] });
        expect(result.options.limit).toBe(10);
    });

    it("normalizes legacy root-level scrape_options", () => {
        const input = {
            url: "https://example.com",
            engine: "playwright",
            scrape_options: {
                formats: ["html"],
            },
        };
        const result = normalizeCrawlPayload(input);
        expect(result.options.scrape_options).toEqual({ formats: ["html"] });
        expect(result.scrape_options).toBeUndefined();
    });

    it("normalizes missing options with defaults", () => {
        const input = {
            url: "https://example.com",
            engine: "cheerio",
        };
        const result = normalizeCrawlPayload(input);
        // After normalization, options should contain scrape_options
        expect(result.options.scrape_options).toEqual({});
    });

    it("preserves existing scrape_options when already nested", () => {
        const input = {
            url: "https://example.com",
            options: {
                limit: 50,
                scrape_options: {
                    timeout: 30000,
                },
            },
        };
        const result = normalizeCrawlPayload(input);
        expect(result.options.scrape_options).toEqual({ timeout: 30000 });
        expect(result.options.limit).toBe(50);
    });
});
