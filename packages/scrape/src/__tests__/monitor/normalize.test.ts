import { normalizeContent, hashContent } from "../../monitor/normalize.js";

describe("monitor/normalize", () => {
    describe("normalizeContent", () => {
        test("prefers markdown and strips the volatile timestamp field", () => {
            const a = normalizeContent({ markdown: "# Title\n\nBody", timestamp: "2026-01-01T00:00:00Z" });
            const b = normalizeContent({ markdown: "# Title\n\nBody", timestamp: "2026-07-11T00:00:00Z" });
            // Different timestamps must not affect normalized output
            expect(a).toBe(b);
            expect(a).toContain("# Title");
        });

        test("falls back to text when markdown is absent", () => {
            const r = normalizeContent({ text: "plain text body" });
            expect(r).toBe("plain text body");
        });

        test("collapses excess blank lines", () => {
            const r = normalizeContent({ markdown: "a\n\n\n\nb" });
            expect(r).toBe("a\n\nb");
        });

        test("ignore_selectors drops matching lines", () => {
            const r = normalizeContent(
                { markdown: "keep this\nAD_SLOT rotating banner\nkeep that" },
                { ignoreSelectors: ["AD_SLOT"] }
            );
            expect(r).not.toContain("AD_SLOT");
            expect(r).toContain("keep this");
            expect(r).toContain("keep that");
        });

        test("empty data yields empty string", () => {
            expect(normalizeContent({})).toBe("");
        });
    });

    describe("hashContent", () => {
        test("is stable and deterministic", () => {
            expect(hashContent("hello")).toBe(hashContent("hello"));
        });

        test("differs for different content", () => {
            expect(hashContent("a")).not.toBe(hashContent("b"));
        });

        test("produces a 64-char hex sha256", () => {
            expect(hashContent("x")).toMatch(/^[0-9a-f]{64}$/);
        });
    });
});
