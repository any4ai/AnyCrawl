import { describe, expect, it, jest } from "@jest/globals";
import {
    SEARCH_SCRAPE_PARTIAL_TIMEOUT_MS,
    collectSettledWithinTimeout,
    resolveSearchFollowUpWaitMs,
} from "../utils/searchFollowUpTiming.js";

describe("search follow-up timing helpers", () => {
    it("caps follow-up wait at the search enrichment window", () => {
        expect(resolveSearchFollowUpWaitMs()).toBe(SEARCH_SCRAPE_PARTIAL_TIMEOUT_MS);
        expect(resolveSearchFollowUpWaitMs(5_000)).toBe(5_000);
        expect(resolveSearchFollowUpWaitMs(120_000)).toBe(SEARCH_SCRAPE_PARTIAL_TIMEOUT_MS);
    });

    it("returns completed promises without marking timeout", async () => {
        const result = await collectSettledWithinTimeout(
            [Promise.resolve("a"), Promise.resolve("b")],
            50
        );

        expect(result.timedOut).toBe(false);
        expect(result.settled.sort()).toEqual(["a", "b"]);
    });

    it("returns partial results when timeout wins", async () => {
        const result = await collectSettledWithinTimeout(
            [
                Promise.resolve("fast"),
                new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 50)),
            ],
            5
        );

        expect(result.timedOut).toBe(true);
        expect(result.settled).toEqual(["fast"]);
    });

    it("reports rejected promises and still returns fulfilled results", async () => {
        const onError = jest.fn();
        const result = await collectSettledWithinTimeout(
            [
                Promise.resolve("ok"),
                Promise.reject(new Error("failed")),
            ],
            50,
            onError
        );

        expect(result.timedOut).toBe(false);
        expect(result.settled).toEqual(["ok"]);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    });
});
