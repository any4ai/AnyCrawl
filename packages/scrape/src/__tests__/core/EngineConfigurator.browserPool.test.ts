import { afterEach, describe, expect, it, jest } from "@jest/globals";

const configure = async (engineType: "playwright" | "puppeteer", options: Record<string, any> = {}) => {
    jest.resetModules();
    const { EngineConfigurator } = await import("../../core/EngineConfigurator.js");
    return EngineConfigurator.configure(options, engineType as any);
};

describe("EngineConfigurator browser pool options", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
    });

    it.each(["playwright", "puppeteer"] as const)("uses resident browser pool defaults for %s", async (engineType) => {
        process.env = { ...originalEnv };
        delete process.env.ANYCRAWL_BROWSER_IDLE_RETIRE_SECS;
        delete process.env.ANYCRAWL_BROWSER_MAX_PAGES_PER_BROWSER;
        delete process.env.ANYCRAWL_BROWSER_MAX_OPEN_PAGES_PER_BROWSER;

        const options = await configure(engineType);

        expect(options.browserPoolOptions).toEqual(expect.objectContaining({
            maxOpenPagesPerBrowser: 20,
            retireBrowserAfterPageCount: 500,
            retireInactiveBrowserAfterSecs: 3600,
            useFingerprints: true,
        }));
    });

    it("preserves explicit browser pool overrides", async () => {
        process.env = { ...originalEnv };

        const options = await configure("playwright", {
            browserPoolOptions: {
                maxOpenPagesPerBrowser: 7,
                retireBrowserAfterPageCount: 70,
                retireInactiveBrowserAfterSecs: 700,
                closeInactiveBrowserAfterSecs: 30,
            },
        });

        expect(options.browserPoolOptions).toEqual(expect.objectContaining({
            maxOpenPagesPerBrowser: 7,
            retireBrowserAfterPageCount: 70,
            retireInactiveBrowserAfterSecs: 700,
            closeInactiveBrowserAfterSecs: 30,
            useFingerprints: true,
        }));
    });
});
