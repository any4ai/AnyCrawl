import { describe, expect, it, jest } from "@jest/globals";
import { SearchService } from "../SearchService.js";
import { HttpClient } from "@anycrawl/scrape";
import type { SearchEngine, SearchOptions } from "../engines/types.js";

class StubSearchEngine implements SearchEngine {
    readonly supportsDirectLimit = true;

    async search(_options: SearchOptions) {
        return {
            url: "https://search.example.test/?q=anycrawl",
            headers: {},
            cookies: {},
            requireProxy: false,
        };
    }

    getName(): string {
        return "stub";
    }

    async parse(_html: string) {
        return [
            {
                title: "Example",
                url: "https://example.com",
                description: "Example result",
                source: "stub",
                category: "web" as const,
            },
        ];
    }
}

describe("SearchService", () => {
    it("awaits async page callbacks before returning search results", async () => {
        const service = new SearchService({ defaultEngine: "google" });
        const httpGetSpy = jest
            .spyOn(HttpClient, "get")
            .mockResolvedValue({ status: 200, headers: {}, data: "<html></html>", rawText: "<html></html>" });

        const stubEngine = new StubSearchEngine();
        jest.spyOn(service, "getEngine").mockReturnValue(stubEngine);

        const events: string[] = [];
        const results = await service.search("google", { query: "anycrawl", limit: 1 }, async (_page, pageResults) => {
            events.push("callback-start");
            await new Promise((resolve) => setTimeout(resolve, 5));
            (pageResults[0] as any).markdown = "# Scraped content";
            events.push("callback-end");
        });

        expect(results[0]).toMatchObject({
            title: "Example",
            markdown: "# Scraped content",
        });
        expect(events).toEqual(["callback-start", "callback-end"]);
        expect(httpGetSpy).toHaveBeenCalledWith(
            "https://search.example.test/?q=anycrawl",
            expect.objectContaining({ requireProxy: false })
        );
    });
});
