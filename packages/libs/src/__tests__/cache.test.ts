import { describe, expect, it } from "@jest/globals";
import {
    computeArtifactOptionsHash,
    computeCacheKey,
    computeSnapshotKey,
    shouldCache,
} from "../cache/index.js";

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

describe("artifact cache keys", () => {
    it("keeps snapshot hash stable across different formats", () => {
        const base = {
            url: "https://example.com/docs?utm_source=test&a=1",
            engine: "cheerio",
            proxy: "auto",
            formats: ["markdown"],
        };

        const markdownSnapshot = computeSnapshotKey(base);
        const htmlSnapshot = computeSnapshotKey({ ...base, formats: ["html", "markdown"] });
        const legacyMarkdown = computeCacheKey(base);
        const legacyHtml = computeCacheKey({ ...base, formats: ["html", "markdown"] });

        expect(markdownSnapshot.snapshotHash).toBe(htmlSnapshot.snapshotHash);
        expect(legacyMarkdown.optionsHash).not.toBe(legacyHtml.optionsHash);
    });

    it("separates markdown artifacts by OCR option", () => {
        const common = {
            url: "https://example.com",
            engine: "cheerio",
            artifactType: "markdown" as const,
        };

        expect(computeArtifactOptionsHash({ ...common, ocr_options: false }))
            .not.toBe(computeArtifactOptionsHash({ ...common, ocr_options: true }));
    });

    it("separates json artifacts by schema and extract source", () => {
        const common = {
            url: "https://example.com",
            engine: "cheerio",
            artifactType: "json" as const,
            modelId: "extract-model",
        };

        const first = computeArtifactOptionsHash({
            ...common,
            extract_source: "markdown",
            json_options: { schema: { type: "object", properties: { title: { type: "string" } } } },
        });
        const second = computeArtifactOptionsHash({
            ...common,
            extract_source: "html",
            json_options: { schema: { type: "object", properties: { title: { type: "string" } } } },
        });

        expect(first).not.toBe(second);
    });
});
