import { describe, expect, test } from "@jest/globals";
import { parseObservation, thresholdFailures, exitCode } from "../scoring.js";
import { parseConfig, redactText } from "../config.js";

// Minimal excerpts of the observed English page formats. IPs are documentation addresses.
const browserscan = `203.0.113.10
Browser:
Chrome 139.0.0.0 Detection
Bot Detection:
NoDetection
Browser fingerprint authenticity: 70%
Different browser version
-5%
Incognito mode
-10%`;
const creepjs = `FP ID: ${"a".repeat(64)}
31% like headless: abc
0% headless: def
20% stealth: ghi`;
const sannysoft = `User Agent (Old) Mozilla/5.0 Chrome/145.0.0.0
WebDriver (New) missing (passed)
WebDriver Advanced passed`;

describe("Browser-score observations", () => {
    test("extracts explicit BrowserScan metrics and deductions", () => {
        const result = parseObservation("browserscan", browserscan);
        expect(result.ready).toBe(true);
        expect(result.metrics).toEqual({ authenticity: 70, botDetected: false });
        expect(result.details.penalties).toEqual([
            { label: "Different browser version", deduction: 5 },
            { label: "Incognito mode", deduction: 10 },
        ]);
    });
    test("does not treat static BrowserScan 100% as a completed measurement", () => {
        expect(
            parseObservation(
                "browserscan",
                "Browser:\nPlatform:\nBot Detection:\nBrowser fingerprint authenticity: 100%"
            ).ready
        ).toBe(false);
    });
    test("zero authenticity is a real result, not missing data", () => {
        expect(
            parseObservation("browserscan", browserscan.replace("70%", "0%")).metrics.authenticity
        ).toBe(0);
    });
    test("accepts an IPv6 result and an explicit detected bot", () => {
        const result = parseObservation(
            "browserscan",
            browserscan
                .replace("203.0.113.10", "2001:db8::1")
                .replace("NoDetection", "YesDetection")
        );
        expect(result.ready).toBe(true);
        expect(result.metrics.botDetected).toBe(true);
    });
    test("keeps CreepJS metrics separate and preserves zeros", () => {
        expect(parseObservation("creepjs", creepjs).metrics).toEqual({
            likeHeadless: 31,
            headless: 0,
            stealth: 20,
        });
    });
    test("CreepJS Computing and its initial zero placeholders are incomplete", () => {
        expect(
            parseObservation("creepjs", creepjs.replace("a".repeat(64), "Computing...")).ready
        ).toBe(false);
    });
    test("a changed CreepJS layout cannot silently pass", () => {
        expect(
            parseObservation("creepjs", creepjs.replace("20% stealth:", "stealth unavailable:"))
                .ready
        ).toBe(false);
    });
    test("reads Sannysoft checks without inventing a score", () => {
        expect(parseObservation("sannysoft", sannysoft).metrics).toEqual({
            webdriverPassed: true,
            advancedPassed: true,
        });
    });
    test("an explicit failed WebDriver check is a valid negative observation", () => {
        const result = parseObservation(
            "sannysoft",
            sannysoft.replace("missing (passed)", "present (failed)")
        );
        expect(result.ready).toBe(true);
        expect(result.metrics.webdriverPassed).toBe(false);
        expect(thresholdFailures("sannysoft", result, { requireWebdriver: true })).toHaveLength(1);
    });
    test.each([
        undefined,
        {},
        { score: 0.9 },
        { success: false, score: 0.9 },
        { success: true, score: "0.9" },
        { success: true, score: 2 },
        { success: true, score: NaN },
    ])("rejects invalid reCAPTCHA verification: %j", (backend) => {
        expect(parseObservation("recaptcha", "score: 0.9", backend).ready).toBe(false);
    });
    test("only a successful backend response provides the reCAPTCHA score", () => {
        expect(
            parseObservation("recaptcha", "loading", {
                success: true,
                score: 0,
                token: "not retained",
                action: "test",
            })
        ).toMatchObject({ ready: true, metrics: { score: 0 }, details: { action: "test" } });
        expect(
            parseObservation("recaptcha", "", { success: true, score: 0.9, token: "secret" })
                .details
        ).not.toHaveProperty("token");
    });
    test("threshold direction differs by metric", () => {
        expect(
            thresholdFailures("browserscan", parseObservation("browserscan", browserscan), {
                minAuthenticity: 75,
            })
        ).toHaveLength(1);
        expect(
            thresholdFailures("creepjs", parseObservation("creepjs", creepjs), { maxStealth: 0 })
        ).toHaveLength(1);
        expect(
            thresholdFailures(
                "recaptcha",
                parseObservation("recaptcha", "", { success: true, score: 0.3 }),
                { minRecaptcha: 0.5 }
            )
        ).toHaveLength(1);
    });
    test("missing metrics cannot pass a configured gate", () => {
        expect(
            thresholdFailures(
                "creepjs",
                { ready: true, metrics: {}, details: {} },
                { maxStealth: 0 }
            )
        ).toHaveLength(1);
    });
    test("unavailable observations and execution errors are never successful exits", () => {
        expect(exitCode([])).toBe(2);
        expect(
            exitCode([
                { status: "completed", failures: [] },
                { status: "unavailable", failures: [] },
            ])
        ).toBe(2);
        expect(exitCode([{ status: "completed", failures: ["below threshold"] }])).toBe(1);
        expect(exitCode([{ status: "completed", failures: [] }])).toBe(0);
        expect(exitCode([{ status: "completed", failures: [] }], "launch failed")).toBe(2);
    });
});

describe("Browser-score configuration and redaction", () => {
    test("requires a proxy or explicit direct mode", () => {
        expect(() => parseConfig([], {})).toThrow("Proxy entry missing");
        expect(parseConfig(["--network", "direct"], {}).network).toBe("direct");
    });
    test("selects exactly the requested configured proxy entry", () => {
        const config = parseConfig(["--proxy-index", "1", "--headed"], {
            ANYCRAWL_PROXY_URL: "http://first:80,http://second:80",
        });
        expect(config.proxyUrl).toBe("http://second:80");
        expect(config.headless).toBe(false);
    });
    test.each([
        ["--sites", "missing"],
        ["--sites", "creepjs,creepjs"],
        ["--rounds", "0"],
        ["--rounds", "2.5"],
        ["--seed", "NaN"],
        ["--max-stealth", "101"],
        ["--min-recaptcha", "-0.1"],
        ["--sites", "sannysoft", "--max-stealth", "0"],
        ["--headed", "--headless"],
        ["--timezone", "not/a/timezone"],
    ])("rejects invalid options: %j", (...args) => {
        expect(() => parseConfig(["--network", "direct", ...args], {})).toThrow();
    });
    test("zero thresholds are retained and no default score thresholds are invented", () => {
        expect(
            parseConfig(["--network", "direct", "--max-stealth", "0"], {}).thresholds.maxStealth
        ).toBe(0);
        expect(parseConfig(["--network", "direct"], {}).thresholds.minAuthenticity).toBeUndefined();
    });
    test("redacts raw and encoded credentials plus license keys without invalid JSON", () => {
        const proxy = "http://test-user:sec%22ret@example.test:80";
        const clean = redactText(
            `launch ${proxy}; sec"ret; sec%22ret; test-user; cb_test_secret`,
            proxy,
            ["cb_test_secret"]
        );
        expect(clean).not.toMatch(/sec|test-user|cb_test/);
        expect(JSON.parse(JSON.stringify({ error: clean })).error).toBe(clean);
    });
    test("also strips userinfo from unknown URLs and reCAPTCHA query tokens", () => {
        expect(redactText("https://name:password@host.test/path?token=abc123")).toBe(
            "https://[redacted]@host.test/path?token=[redacted]"
        );
    });
});
