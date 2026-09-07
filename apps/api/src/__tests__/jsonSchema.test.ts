import { describe, expect, it } from "@jest/globals";
import request from "supertest";
import { z } from "zod";

const BASE_URL = process.env.ANYCRAWL_BASE_URL || "http://127.0.0.1:8080";
const REQUEST_TIMEOUT = 120_000;
const TEST_TIMEOUT = REQUEST_TIMEOUT + 15_000;
const pageSchema = {
    type: "object",
    properties: { title: { type: "string" }, description: { type: "string" } },
    required: ["title", "description"],
};
const linkSchema = {
    type: "object",
    properties: { label: { type: "string" }, href: { type: "string" } },
    required: ["label", "href"],
};
const pageOutput = z.object({ title: z.string().regex(/example domain/i), description: z.string().min(1) });
const linksOutput = z.array(z.object({ label: z.string().min(1), href: z.string().url() })).min(1);

// These exercise real extraction. Input-only rejection tests below never call an LLM.
describe("JSON extraction through the API", () => {
    const cases = [
        { name: "object", schema: pageSchema, output: pageOutput },
        { name: "nested object", schema: { type: "object", properties: { page: pageSchema }, required: ["page"] }, output: z.object({ page: pageOutput }) },
        // The existing extractor normalizes a root array to an object with items.
        { name: "root array", schema: { type: "array", items: linkSchema }, output: z.object({ items: linksOutput }) },
        { name: "nested object with array", schema: { type: "object", properties: { page: pageSchema, links: { type: "array", items: linkSchema } }, required: ["page", "links"] }, output: z.object({ page: pageOutput, links: linksOutput }) },
    ];
    it.each(cases)("extracts and validates $name", async ({ name, schema, output }) => {
        const started = Date.now();
        const response = await request(BASE_URL).post("/v1/scrape").timeout(REQUEST_TIMEOUT).send({
            url: "https://example.com/", engine: "cheerio", formats: ["json"],
            json_options: { schema, user_prompt: "Extract the page title, description, and hyperlinks that are present in the input. Preserve the actual hyperlink URLs." },
        });
        console.info(`JSON extraction (${name}) duration: ${Date.now() - started} ms`);
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.status).toBe("completed");
        expect(response.body.data.json).toBeDefined();
        expect(() => output.parse(response.body.data.json)).not.toThrow();
    }, TEST_TIMEOUT);
});

describe("JSON schema input validation through the API", () => {
    it.each([
        { type: "invalid_type", properties: { title: { type: "string" } } },
        { type: "object", properties: "invalid" },
    ])("rejects invalid schema before extraction: %j", async (schema) => {
        const response = await request(BASE_URL).post("/v1/scrape").timeout(10_000).send({
            url: "https://example.com/", engine: "cheerio", formats: ["json"], json_options: { schema },
        });
        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
    }, 15_000);
});
