import { describe, expect, it } from "@jest/globals";
import { QuickJSSandbox } from "../sandbox/index.js";
import type { SandboxContext, TemplateConfig } from "@anycrawl/libs";

const createTemplate = (trusted: boolean): TemplateConfig => ({
    uuid: `sandbox-markdown-${trusted ? "trusted" : "vm"}`,
    templateId: `sandbox-markdown-${trusted ? "trusted" : "vm"}`,
    name: "Sandbox Markdown Test",
    description: "Verifies markdown is exposed in sandbox context",
    tags: ["test"],
    version: "1.0.0",
    pricing: {
        perCall: 1,
        currency: "credits",
    },
    templateType: "scrape",
    reqOptions: {
        engine: "playwright",
        formats: ["markdown"],
    },
    metadata: {},
    createdBy: "test",
    status: "published",
    reviewStatus: "approved",
    trusted,
    createdAt: new Date(),
    updatedAt: new Date(),
});

const createContext = (trusted: boolean): SandboxContext => ({
    template: createTemplate(trusted),
    executionContext: {
        templateId: `sandbox-markdown-${trusted ? "trusted" : "vm"}`,
        request: {
            url: "https://example.com",
            method: "GET",
        },
        response: {
            body: Buffer.from("<main><h1>Hello Markdown</h1><p>Template input.</p></main>")
        } as any,
    },
    variables: {},
});

describe("QuickJSSandbox", () => {
    it("exposes context.markdown in VM sandbox", async () => {
        const sandbox = new QuickJSSandbox();

        const result = await sandbox.executeCode("return context.markdown;", createContext(false));

        expect(result.result).toContain("# Hello Markdown");
        expect(result.result).toContain("Template input.");
    });

    it("exposes context.markdown in trusted sandbox", async () => {
        const sandbox = new QuickJSSandbox();

        const result = await sandbox.executeCode("return context.markdown;", createContext(true));

        expect(result.result).toContain("# Hello Markdown");
        expect(result.result).toContain("Template input.");
    });
});
