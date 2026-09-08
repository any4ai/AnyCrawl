import { describe, expect, test } from "@jest/globals";
import { toCloakBrowserOptions } from "../../core/CloakBrowserOptions.js";

describe("CloakBrowser option adaptation", () => {
    test("uses Crawlee's authenticated transport for Puppeteer GeoIP and launch without duplicate proxy flags", () => {
        const adapted = toCloakBrowserOptions({
            __anycrawlNativeFingerprint: true,
            proxy: "http://account:secret@upstream.test:8080", geoip: true,
            args: ["--fingerprint=123", "--proxy-server=http://127.0.0.1:12345"],
        }, "puppeteer");
        expect(adapted.proxy).toBe("http://127.0.0.1:12345");
        expect(adapted.geoip).toBe(true);
        expect(adapted.args).toEqual(["--fingerprint=123"]);
    });
    test("keeps wrapper flags separate from native launch and context fields", () => {
        const env = { TEST_MARKER: "present" };
        const options = toCloakBrowserOptions(
            {
                headless: false,
                proxy: "http://proxy.example:8080",
                geoip: true,
                args: ["--fingerprint=12345"],
                timeout: 9000,
                slowMo: 2,
                env,
                ignoreHTTPSErrors: true,
                javaScriptEnabled: false,
                userAgent: "explicit",
                viewport: { width: 900, height: 700 },
                timezoneId: "Europe/London",
                locale: "en-GB",
            },
            "playwright"
        );
        expect(options).toEqual({
            headless: false,
            proxy: "http://proxy.example:8080",
            geoip: true,
            args: ["--fingerprint=12345"],
            timezone: "Europe/London",
            locale: "en-GB",
            launchOptions: { timeout: 9000, slowMo: 2, env },
            contextOptions: { ignoreHTTPSErrors: true, javaScriptEnabled: false },
            userAgent: "explicit",
            viewport: { width: 900, height: 700 },
        });
    });
    test("merges nested options without letting raw args replace stealth argument construction", () => {
        const input = {
            launchOptions: { args: ["--a"], timeout: 1, headless: true },
            args: ["--b"],
            timeout: 2,
            headless: false,
        };
        expect(toCloakBrowserOptions(input, "playwright")).toEqual({
            args: ["--a", "--b"],
            headless: false,
            launchOptions: { timeout: 2 },
        });
        expect(input.launchOptions.args).toEqual(["--a"]);
    });
    test("routes persistent context fields and legacy explicit viewport", () => {
        expect(
            toCloakBrowserOptions(
                {
                    userDataDir: "/tmp/profile",
                    defaultViewport: null,
                    contextOptions: {
                        locale: "de-DE",
                        timezoneId: "Europe/Berlin",
                        permissions: ["geolocation"],
                    },
                },
                "playwright",
                true
            )
        ).toEqual({
            userDataDir: "/tmp/profile",
            viewport: null,
            locale: "de-DE",
            timezone: "Europe/Berlin",
            contextOptions: { permissions: ["geolocation"] },
        });
    });
    test("preserves Puppeteer native launch fields", () => {
        expect(
            toCloakBrowserOptions(
                {
                    headless: true,
                    defaultViewport: { width: 800, height: 600 },
                    protocolTimeout: 7000,
                    userDataDir: "/tmp/profile",
                    env: { TEST: "1" },
                },
                "puppeteer"
            )
        ).toEqual({
            headless: true,
            launchOptions: {
                protocolTimeout: 7000,
                userDataDir: "/tmp/profile",
                env: { TEST: "1" },
                defaultViewport: { width: 800, height: 600 },
            },
        });
    });
    test("honors nested explicit viewport and flat overrides", () => {
        expect(
            toCloakBrowserOptions(
                { launchOptions: { defaultViewport: { width: 800, height: 600 } } },
                "playwright"
            ).viewport
        ).toEqual({ width: 800, height: 600 });
        expect(
            toCloakBrowserOptions(
                {
                    launchOptions: { defaultViewport: { width: 800, height: 600 } },
                    defaultViewport: null,
                },
                "playwright"
            ).viewport
        ).toBeNull();
    });
    test("removes only framework-added UA in native mode, without forwarding metadata", () => {
        expect(
            toCloakBrowserOptions(
                {
                    args: ["--x", "--user-agent=Chrome/107"],
                    __anycrawlNativeFingerprint: true,
                    __anycrawlExplicitUserAgent: false,
                },
                "playwright"
            )
        ).toEqual({ args: ["--x"] });
        expect(
            toCloakBrowserOptions(
                {
                    args: ["--user-agent=explicit"],
                    __anycrawlNativeFingerprint: true,
                    __anycrawlExplicitUserAgent: true,
                },
                "playwright"
            ).args
        ).toEqual(["--user-agent=explicit"]);
        expect(
            toCloakBrowserOptions(
                {
                    launchOptions: { args: ["--user-agent=explicit"] },
                    args: ["--user-agent=Chrome/107"],
                    __anycrawlNativeFingerprint: true,
                    __anycrawlUserAgentArgs: ["--user-agent=explicit"],
                },
                "playwright"
            )
        ).toEqual({ args: ["--user-agent=explicit"] });
    });
});
