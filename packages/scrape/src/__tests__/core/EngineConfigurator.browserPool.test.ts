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

    it.each(["playwright", "puppeteer"] as const)("uses native identity and exact proxy matching for CloakBrowser %s", async (engineType) => {
        process.env = { ...originalEnv, ANYCRAWL_BROWSER_GEOIP: "true" };
        const options = await configure(engineType, {
            launchContext: { launcher: { __anycrawlBrowserRuntime: "cloakbrowser" }, browserPerProxy: false, useIncognitoPages: true },
            browserPoolOptions: { useFingerprints: true },
        });
        expect(options.browserPoolOptions.useFingerprints).toBe(false);
        expect(options.launchContext.browserPerProxy).toBe(true);
        expect(options.launchContext.useIncognitoPages).toBe(true);
        const launchContext: any = { launchOptions: { headless: true, args: [] }, proxyUrl: "http://example.test:8080", proxyTier: 1 };
        for (const hook of options.browserPoolOptions.preLaunchHooks) await hook("page", launchContext);
        expect(launchContext.launchOptions).toMatchObject({ geoip: true, proxy: "http://example.test:8080", __anycrawlNativeFingerprint: true, __anycrawlExplicitUserAgent: false });
        const controller: any = { proxyTier: 1, proxyUrl: "http://other.test:8080", launchContext };
        for (const hook of options.browserPoolOptions.postLaunchHooks) await hook("page", controller);
        expect(controller.proxyTier).toBeUndefined();
        expect(controller.proxyUrl).toBe(launchContext.proxyUrl);
        expect(controller.launchContext.proxyTier).toBe(1);
        const { BrowserPool } = await import("crawlee");
        const plugin = {};
        controller.browserPlugin = plugin;
        controller.activePages = 0;
        const pool = { activeBrowserControllers: new Set([controller]), maxOpenPagesPerBrowser: 20 };
        // Exercise the installed Crawlee selector: the same tier must not permit a different proxy.
        const pick = (BrowserPool.prototype as any)._pickBrowserWithFreeCapacity;
        expect(pick.call(pool, plugin, { proxyTier: 1, proxyUrl: "http://other.test:8080" })).toBeUndefined();
        expect(pick.call(pool, plugin, { proxyTier: 1, proxyUrl: launchContext.proxyUrl })).toBe(controller);
    });

    it("does not force a CloakBrowser viewport or run GeoIP for direct traffic", async () => {
        process.env = { ...originalEnv, ANYCRAWL_BROWSER_GEOIP: "true" };
        const options = await configure("playwright", { launchContext: { launcher: { __anycrawlBrowserRuntime: "cloakbrowser" } } });
        const setViewportSize = jest.fn();
        await options.preNavigationHooks[0]({ page: { setViewportSize }, request: { userData: {} } }, {});
        expect(setViewportSize).not.toHaveBeenCalled();
        const launchContext: any = { launchOptions: {} };
        for (const hook of options.browserPoolOptions.preLaunchHooks) await hook("page", launchContext);
        expect(launchContext.launchOptions.geoip).toBe(false);
    });
});
