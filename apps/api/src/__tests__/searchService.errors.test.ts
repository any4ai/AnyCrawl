import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const get = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule("@anycrawl/scrape", () => ({ HttpClient: { get } }));
const { SearchService } = await import("@anycrawl/search/SearchService");

const result = { title: "Fixture result", url: "https://example.com/", content: "A result", engine: "google" };
const response = (status: number, results: any[] = []) => ({ status, headers: {}, data: { results } });
const service = () => new SearchService({ defaultEngine: "searxng", enabledEngines: ["searxng"], searxngUrl: "http://search-fixture.invalid" });

beforeEach(() => { get.mockReset(); });

describe("SearchService upstream errors", () => {
    it("preserves a successful empty result", async () => {
        get.mockResolvedValue(response(200));
        const onPage = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
        await expect(service().search("searxng", { query: "empty" }, onPage)).resolves.toEqual([]);
        expect(onPage).toHaveBeenCalledWith(1, [], "searxng", true);
    });

    it("handles an empty query without sending an invalid upstream request", async () => {
        const onPage = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
        await expect(service().search("searxng", { query: "" }, onPage)).resolves.toEqual([]);
        expect(get).not.toHaveBeenCalled();
        expect(onPage).toHaveBeenCalledWith(1, [], "searxng", true);
    });

    it.each([400, 422])("propagates upstream parameter rejection (%i)", async (status) => {
        get.mockResolvedValue(response(status));
        const onPage = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
        await expect(service().search("searxng", { query: "keyword", lang: "invalid-lang" }, onPage)).rejects.toMatchObject({
            code: "SEARCH_INVALID_REQUEST", httpStatus: 400, upstreamStatus: status,
        });
        expect(onPage).toHaveBeenCalledWith(1, [], "searxng", false);
    });

    it.each([401, 403, 429, 500, 502, 503])("reports upstream HTTP %i as a gateway failure", async (status) => {
        get.mockResolvedValue(response(status));
        await expect(service().search("searxng", { query: "keyword" })).rejects.toMatchObject({
            code: "SEARCH_UPSTREAM_ERROR", httpStatus: 502, upstreamStatus: status,
        });
    });

    it("reports transport errors without leaking upstream credentials", async () => {
        get.mockRejectedValue(new Error("connect failed http://user:private-password@proxy.invalid"));
        await expect(service().search("searxng", { query: "keyword" })).rejects.toMatchObject({
            code: "SEARCH_UPSTREAM_ERROR", httpStatus: 502, message: "Search upstream request failed",
        });
    });

    it.each([false, true])("withholds partial success when any page fails (concurrent=%s)", async (concurrent) => {
        get.mockImplementation(async (url: string) => new URL(url).searchParams.get("pageno") === "1" ? response(200, [result]) : response(502));
        const onPage = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
        await expect(service().search("searxng", { query: "keyword", limit: 20, concurrent }, onPage)).rejects.toMatchObject({ code: "SEARCH_UPSTREAM_ERROR" });
        expect(onPage).toHaveBeenCalledTimes(1);
        expect(onPage).toHaveBeenCalledWith(2, [], "searxng", false);
    });

    it("awaits successful page callbacks in page order", async () => {
        get.mockResolvedValue(response(200, [result]));
        const handled: number[] = [];
        const results = await service().search("searxng", { query: "keyword", limit: 20, concurrent: true }, async (page) => {
            await new Promise(resolve => setTimeout(resolve, 5));
            handled.push(page);
        });
        expect(handled).toEqual([1, 2]);
        expect(results).toHaveLength(2);
    });
});
