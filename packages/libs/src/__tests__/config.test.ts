import { afterEach, describe, expect, it, jest } from "@jest/globals";

const ORIGINAL_ENV = process.env;

const loadConfig = async () => {
    jest.resetModules();
    return (await import("../config.js")).config;
};

describe("config.engine", () => {
    afterEach(() => {
        process.env = ORIGINAL_ENV;
        jest.resetModules();
    });

    it("keeps crawlers alive by default", async () => {
        process.env = { ...ORIGINAL_ENV };
        delete process.env.ANYCRAWL_KEEP_ALIVE;
        delete process.env.ANYCRAWL_KEEPALIVE;

        const config = await loadConfig();

        expect(config.engine.keepAlive).toBe(true);
    });

    it("prefers ANYCRAWL_KEEP_ALIVE over the legacy ANYCRAWL_KEEPALIVE alias", async () => {
        process.env = {
            ...ORIGINAL_ENV,
            ANYCRAWL_KEEP_ALIVE: "false",
            ANYCRAWL_KEEPALIVE: "true",
        };

        const config = await loadConfig();

        expect(config.engine.keepAlive).toBe(false);
    });

    it("still supports the legacy ANYCRAWL_KEEPALIVE alias", async () => {
        process.env = {
            ...ORIGINAL_ENV,
            ANYCRAWL_KEEPALIVE: "false",
        };
        delete process.env.ANYCRAWL_KEEP_ALIVE;

        const config = await loadConfig();

        expect(config.engine.keepAlive).toBe(false);
    });

    it("uses resident browser pool defaults", async () => {
        process.env = { ...ORIGINAL_ENV };
        delete process.env.ANYCRAWL_BROWSER_IDLE_RETIRE_SECS;
        delete process.env.ANYCRAWL_BROWSER_MAX_PAGES_PER_BROWSER;
        delete process.env.ANYCRAWL_BROWSER_MAX_OPEN_PAGES_PER_BROWSER;
        delete process.env.ANYCRAWL_BROWSER_ISOLATE_CONTEXTS;

        const config = await loadConfig();

        expect(config.engine.browserIdleRetireSecs).toBe(3600);
        expect(config.engine.browserMaxPagesPerBrowser).toBe(500);
        expect(config.engine.browserMaxOpenPagesPerBrowser).toBe(20);
        expect(config.engine.browserIsolateContexts).toBe(true);
    });

    it("falls back when resident browser pool numeric values are not positive", async () => {
        process.env = {
            ...ORIGINAL_ENV,
            ANYCRAWL_BROWSER_IDLE_RETIRE_SECS: "0",
            ANYCRAWL_BROWSER_MAX_PAGES_PER_BROWSER: "-1",
            ANYCRAWL_BROWSER_MAX_OPEN_PAGES_PER_BROWSER: "not-a-number",
            ANYCRAWL_BROWSER_ISOLATE_CONTEXTS: "false",
        };

        const config = await loadConfig();

        expect(config.engine.browserIdleRetireSecs).toBe(3600);
        expect(config.engine.browserMaxPagesPerBrowser).toBe(500);
        expect(config.engine.browserMaxOpenPagesPerBrowser).toBe(20);
        expect(config.engine.browserIsolateContexts).toBe(false);
    });
});
