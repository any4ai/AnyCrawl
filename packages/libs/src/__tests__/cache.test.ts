import { describe, expect, it } from "@jest/globals";
import { computeCacheKey, shouldCache, getBrowserRuntimeForCache } from "../cache/index.js";

describe("shouldCache", () => {
    it("returns false for title-only markdown payloads", () => {
        const options = {};
        const result = {
            title: "Labor market reforms and unemployment fluctuations | Oxford Economic Papers | Oxford Academic",
            metadata: [],
            markdown: "Labor market reforms and unemployment fluctuations | Oxford Economic Papers | Oxford Academic",
        };

        expect(shouldCache(options, result)).toBe(false);
    });

    it("returns true when markdown contains real body content", () => {
        const options = {};
        const result = {
            title: "Example Page",
            metadata: [],
            markdown: "# Example Page\n\nThis page contains substantive body text.",
        };

        expect(shouldCache(options, result)).toBe(true);
    });

    it("returns true for screenshot-only payloads", () => {
        const options = {};
        const result = {
            title: "Screenshot Result",
            metadata: [],
            screenshot: "screenshot-job-abc.jpeg",
        };

        expect(shouldCache(options, result)).toBe(true);
    });
});

describe("computeCacheKey", () => {
    it("invalidates legacy browser entries and partitions explicit region policies", () => {
        const original = process.env;
        try {
            process.env = { ...original, ANYCRAWL_BROWSER_TIMEZONE: "Europe/London", ANYCRAWL_BROWSER_LOCALE: "en-GB" };
            const london = getBrowserRuntimeForCache("playwright");
            expect(london).toMatch(/^cloakbrowser-native-v1:/);
            expect(london).not.toBe("cloakbrowser");
            expect(getBrowserRuntimeForCache("cheerio")).toBeUndefined();
            process.env.ANYCRAWL_BROWSER_TIMEZONE = "America/New_York";
            expect(getBrowserRuntimeForCache("playwright")).not.toBe(london);
        } finally { process.env = original; }
    });
    it("separates browser runtime cache entries for playwright", () => {
        const base = {
            url: "https://example.com",
            engine: "playwright",
            formats: ["markdown"],
        };

        const defaultRuntime = computeCacheKey(base);
        const cloakRuntime = computeCacheKey({
            ...base,
            browser_runtime: "cloakbrowser",
        });

        expect(defaultRuntime.urlHash).toBe(cloakRuntime.urlHash);
        expect(defaultRuntime.optionsHash).not.toBe(cloakRuntime.optionsHash);
    });

    it("does not let browser runtime affect cheerio cache entries", () => {
        const base = {
            url: "https://example.com",
            engine: "cheerio",
            formats: ["markdown"],
        };

        expect(computeCacheKey(base)).toEqual(computeCacheKey({
            ...base,
            browser_runtime: "cloakbrowser",
        }));
    });
});
