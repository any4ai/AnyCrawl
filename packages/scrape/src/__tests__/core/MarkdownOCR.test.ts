import { describe, expect, it } from "@jest/globals";
import {
    OCR_BLOCK_CLOSE,
    OCR_BLOCK_OPEN,
    collectMarkdownImageOccurrences,
    injectOCRBlocksAfterImages,
    normalizeOCRText,
} from "../../core/MarkdownOCR.js";

describe("MarkdownOCR", () => {
    it("collects markdown image occurrences for plain and linked images", () => {
        const markdown = [
            "Intro",
            "",
            "![first](https://example.com/a.png)",
            "",
            "[![second](https://example.com/b.png)](https://example.com/details)",
            "",
            "Tail",
        ].join("\n");

        const occurrences = collectMarkdownImageOccurrences(markdown);

        expect(occurrences).toHaveLength(2);
        expect(occurrences[0]?.imageUrl).toBe("https://example.com/a.png");
        expect(occurrences[1]?.imageUrl).toBe("https://example.com/b.png");

        const secondSpan = markdown.slice(occurrences[1]!.imageStart - 1, occurrences[1]!.insertAfter);
        expect(secondSpan).toBe("[![second](https://example.com/b.png)](https://example.com/details)");
    });

    it("injects OCR block immediately after each image token", () => {
        const markdown = [
            "![first](https://example.com/a.png)",
            "",
            "[![second](https://example.com/b.png)](https://example.com/details)",
        ].join("\n");
        const occurrences = collectMarkdownImageOccurrences(markdown);
        const ocrMap = new Map<string, string>([
            ["https://example.com/a.png", "first image text"],
            ["https://example.com/b.png", "second image text"],
        ]);

        const output = injectOCRBlocksAfterImages(markdown, occurrences, ocrMap);

        expect(output).toContain("![first](https://example.com/a.png)\n\n[ANYCRAWL_OCR_TEXT]\nfirst image text\n[/ANYCRAWL_OCR_TEXT]");
        expect(output).toContain("[![second](https://example.com/b.png)](https://example.com/details)\n\n[ANYCRAWL_OCR_TEXT]\nsecond image text\n[/ANYCRAWL_OCR_TEXT]");
    });

    it("injects empty OCR block when OCR text is unavailable", () => {
        const markdown = "![first](https://example.com/a.png)";
        const occurrences = collectMarkdownImageOccurrences(markdown);
        const output = injectOCRBlocksAfterImages(markdown, occurrences, new Map());

        expect(output).toContain(OCR_BLOCK_OPEN);
        expect(output).toContain(OCR_BLOCK_CLOSE);
    });

    it("normalizes OCR text and removes marker tags", () => {
        const normalized = normalizeOCRText("  line1\r\n\r\n\r\n[ANYCRAWL_OCR_TEXT]line2[/ANYCRAWL_OCR_TEXT]  ");
        expect(normalized).toBe("line1\n\nline2");
    });
});
