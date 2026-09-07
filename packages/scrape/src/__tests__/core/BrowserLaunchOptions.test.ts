import { afterEach, describe, expect, test } from "@jest/globals";
import {
    getBrowserLaunchOptions,
    shouldResolveBrowserGeoip,
} from "../../core/BrowserLaunchOptions.js";

describe("native browser region policy", () => {
    const original = process.env;
    afterEach(() => {
        process.env = original;
    });
    test("uses native region settings without a forced viewport", () => {
        process.env = {
            ...original,
            ANYCRAWL_BROWSER_TIMEZONE: "Europe/London",
            ANYCRAWL_BROWSER_LOCALE: "en-GB",
            ANYCRAWL_HEADLESS: "false",
        };
        expect(getBrowserLaunchOptions()).toMatchObject({
            timezone: "Europe/London",
            locale: "en-GB",
            headless: false,
        });
        expect(getBrowserLaunchOptions()).not.toHaveProperty("defaultViewport");
    });
    test("resolves proxy geography only when needed", () => {
        process.env = { ...original, ANYCRAWL_BROWSER_GEOIP: "true" };
        expect(shouldResolveBrowserGeoip({}, true)).toBe(true);
        expect(shouldResolveBrowserGeoip({}, false)).toBe(false);
        expect(
            shouldResolveBrowserGeoip({ timezone: "Europe/London", locale: "en-GB" }, true)
        ).toBe(false);
        expect(
            shouldResolveBrowserGeoip(
                { args: ["--fingerprint-timezone=Europe/London", "--lang=en-GB"] },
                true
            )
        ).toBe(false);
        expect(shouldResolveBrowserGeoip({ timezone: "Europe/London" }, true)).toBe(true);
        expect(shouldResolveBrowserGeoip({ geoip: false }, true)).toBe(false);
        process.env.ANYCRAWL_BROWSER_GEOIP = "false";
        expect(shouldResolveBrowserGeoip({}, true)).toBe(false);
        expect(shouldResolveBrowserGeoip({ geoip: true }, true)).toBe(true);
    });
    test("fails explicitly on invalid operator region settings", () => {
        process.env = { ...original, ANYCRAWL_BROWSER_TIMEZONE: "Invalid/Timezone" };
        expect(() => getBrowserLaunchOptions()).toThrow("ANYCRAWL_BROWSER_TIMEZONE");
        process.env.ANYCRAWL_BROWSER_TIMEZONE = "Europe/London";
        process.env.ANYCRAWL_BROWSER_LOCALE = "not a locale";
        expect(() => getBrowserLaunchOptions()).toThrow("ANYCRAWL_BROWSER_LOCALE");
    });
});
