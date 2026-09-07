import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { startHttpStatusFixture } from "./helpers/httpStatusFixture.js";

const BASE_URL = process.env.ANYCRAWL_BASE_URL || "http://127.0.0.1:8080";
// Functional live checks include queueing and the documented auto-proxy budget.
const REQUEST_TIMEOUT = 120_000;
const TEST_TIMEOUT = REQUEST_TIMEOUT + 15_000;
const engines = ["cheerio", "playwright", "puppeteer"] as const;

describe("Scrape API", () => {
    let fixture: Awaited<ReturnType<typeof startHttpStatusFixture>>;
    beforeAll(async () => { fixture = await startHttpStatusFixture(); });
    afterAll(async () => { await fixture?.close(); });

    it("health check", async () => {
        const response = await request(BASE_URL).get("/");
        expect(response.status).toBe(200);
        expect(response.text).toBe("Hello World");
    });

    it.each([403, 404])("reports a real HTTP %i response as a failed scrape", async (status) => {
        const response = await request(BASE_URL).post("/v1/scrape").timeout(REQUEST_TIMEOUT).send({
            url: `${fixture.url}/status/${status}`,
            proxy: fixture.url,
            engine: "cheerio",
            formats: ["html"],
        });
        expect(fixture.hits.get(status)).toBeGreaterThan(0);
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe("Scrape task failed");
        expect(response.body.data).toMatchObject({ status: "failed", type: "http_error", code: status });
    }, TEST_TIMEOUT);

    it.each(engines)("returns requested HTML and Markdown with %s", async (engine) => {
        const response = await request(BASE_URL).post("/v1/scrape").timeout(REQUEST_TIMEOUT).send({
            url: "https://example.com/", engine, formats: ["html", "markdown"],
        });
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.status).toBe("completed");
        expect(response.body.data.html).toMatch(/example domain/i);
        expect(response.body.data.markdown).toMatch(/example domain/i);
    }, TEST_TIMEOUT);

    it("defaults to Markdown without returning unrequested HTML", async () => {
        const response = await request(BASE_URL).post("/v1/scrape").timeout(REQUEST_TIMEOUT).send({
            url: "https://example.com/", engine: "cheerio",
        });
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.status).toBe("completed");
        expect(response.body.data.markdown).toMatch(/example domain/i);
        expect(response.body.data).not.toHaveProperty("html");
    }, TEST_TIMEOUT);

    it.each(engines)("honors the configured SSL policy with %s", async (engine) => {
        const response = await request(BASE_URL).post("/v1/scrape").timeout(REQUEST_TIMEOUT).send({
            url: "https://expired.badssl.com/", engine, formats: ["html"],
        });
        expect(response.status).toBe(200);
        if (process.env.ANYCRAWL_IGNORE_SSL_ERROR === "true") {
            expect(response.body.success).toBe(true);
            expect(response.body.data.status).toBe("completed");
            expect(response.body.data.html).toMatch(/expired/i);
        } else {
            expect(response.body.success).toBe(false);
            expect(response.body.data.status).toBe("failed");
            expect(response.body.message).toMatch(/ssl|certificate/i);
        }
    }, TEST_TIMEOUT);
});
