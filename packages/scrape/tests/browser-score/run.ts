import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";
import {
    parseConfig,
    identifier,
    redactText,
    VARIANTS,
    type Config,
    type Variant,
} from "./config.js";
import {
    STANDARDS,
    parseObservation,
    thresholdFailures,
    exitCode,
    type Site,
    type Observation,
} from "./scoring.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "../../../..");
const require = createRequire(import.meta.url);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function readVerification(response: { json(): Promise<unknown> }): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            response.json(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Verification body timed out.")), 5000);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
interface RecordResult {
    round: number;
    variant: Variant;
    site: Site;
    status: "completed" | "unavailable" | "error";
    failures: string[];
    observation?: Observation;
    httpStatus?: number;
    challengeHeader?: string;
    elapsedMs?: number;
    identity?: unknown;
    error?: string;
    artifacts: Record<string, string>;
    failedRequests: Array<{ host: string; path: string; error: string | undefined }>;
}

function packageVersion(name: string): string {
    let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));
    // Resolve package metadata without relying on a pnpm store layout or package.json exports.
    while (directory !== path.dirname(directory)) {
        try {
            const pkg = require(path.join(directory, "package.json")) as {
                name?: string;
                version?: string;
            };
            if (pkg.name === name && pkg.version) return pkg.version;
        } catch {
            /* A resolved entry may be nested under dist/. */
        }
        directory = path.dirname(directory);
    }
    throw new Error(`Cannot determine installed version of ${name}.`);
}

async function identity(page: Page): Promise<unknown> {
    return page.evaluate(async () => {
        const nav = navigator as Navigator & {
            deviceMemory?: number;
            userAgentData?: { getHighEntropyValues(keys: string[]): Promise<unknown> };
        };
        let uaData: unknown = null;
        let webgl: unknown = null;
        try {
            uaData =
                (await nav.userAgentData?.getHighEntropyValues([
                    "architecture",
                    "bitness",
                    "platformVersion",
                    "fullVersionList",
                ])) ?? null;
        } catch {
            /* Unsupported surface is recorded as null. */
        }
        try {
            const gl = document.createElement("canvas").getContext("webgl");
            const extension = gl?.getExtension("WEBGL_debug_renderer_info");
            if (gl && extension)
                webgl = {
                    vendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL),
                    renderer: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL),
                };
        } catch {
            /* Unsupported surface is recorded as null. */
        }
        return {
            userAgent: nav.userAgent,
            platform: nav.platform,
            webdriver: nav.webdriver,
            languages: nav.languages,
            hardwareConcurrency: nav.hardwareConcurrency,
            deviceMemory: nav.deviceMemory,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            uaData,
            webgl,
            screen: {
                width: screen.width,
                height: screen.height,
                availWidth: screen.availWidth,
                availHeight: screen.availHeight,
                colorDepth: screen.colorDepth,
            },
            window: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio },
        };
    });
}

export async function collect(
    page: Page,
    site: Site,
    result: RecordResult,
    config: Config
): Promise<string> {
    const standard = STANDARDS[site];
    let backend: unknown;
    const responses: Promise<void>[] = [];
    page.on("requestfailed", (request) => {
        if (result.failedRequests.length >= 100) return;
        const url = new URL(request.url());
        result.failedRequests.push({
            host: url.hostname,
            path: url.pathname,
            error: request.failure()?.errorText,
        });
    });
    page.on("response", (response) => {
        const request = response.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            result.httpStatus = response.status();
            result.challengeHeader = response.headers()["cf-mitigated"];
        }
        const url = new URL(response.url());
        if (
            site === "recaptcha" &&
            url.origin === new URL(standard.url).origin &&
            url.pathname === "/recaptcha-v3-verify.php"
        ) {
            responses.push(
                readVerification(response)
                    .then((value) => {
                        backend = value;
                    })
                    .catch(() => {
                        backend = null;
                    })
            );
        }
    });
    await page.goto(standard.url, {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs,
    });
    const start = Date.now();
    let stableSince = start;
    let previous = "";
    let text = "";
    while (Date.now() - start < config.resultTimeoutMs) {
        text = await page
            .locator("body")
            .innerText({ timeout: Math.min(5000, config.resultTimeoutMs) });
        const observation = parseObservation(site, text, backend);
        const signature = JSON.stringify(observation);
        if (signature !== previous) {
            previous = signature;
            stableSince = Date.now();
        }
        const stableFor = site === "recaptcha" ? 0 : 3000;
        if (
            observation.ready &&
            Date.now() - start >= standard.minimumObservationMs &&
            Date.now() - stableSince >= stableFor
        ) {
            if (result.challengeHeader === "challenge" || (result.httpStatus ?? 0) >= 400) {
                result.error = "The final document is challenged or returned an HTTP error.";
            } else {
                result.status = "completed";
                result.observation = observation;
                result.failures = thresholdFailures(site, observation, config.thresholds);
            }
            break;
        }
        result.error = observation.ready
            ? "Observation did not settle within the sampling window."
            : observation.reason;
        await sleep(Math.min(1000, Math.max(1, config.resultTimeoutMs - (Date.now() - start))));
    }
    await Promise.all(responses);
    if (result.status === "completed") delete result.error;
    return text;
}

function markdown(report: {
    metadata: Record<string, unknown>;
    records: RecordResult[];
    fatalError?: string;
    exitCode: number;
}): string {
    const lines = [
        "# Browser score run",
        "",
        `Exit code: ${report.exitCode}`,
        "",
        "These metrics are separate detector observations, not a combined human probability or Cloudflare success rate.",
        "",
        "| Round | Variant | Site | Status | Metrics | Threshold failures |",
        "| --- | --- | --- | --- | --- | --- |",
    ];
    for (const row of report.records)
        lines.push(
            `| ${row.round} | ${row.variant} | ${row.site} | ${row.status} | ${row.observation ? JSON.stringify(row.observation.metrics) : "unavailable"} | ${row.failures.join("; ") || "—"} |`
        );
    if (report.fatalError)
        lines.push("", `Setup/runtime error: ${report.fatalError.replace(/\n/g, " ")}`);
    lines.push(
        "",
        "See report.json and the per-attempt JSON/text/screenshots for evidence and errors.",
        "",
        "A completed observation without configured thresholds is a successful collection, not a declaration that the browser passes every detector.",
        "Sampling and navigation times are diagnostic timings, not scrape-performance measurements.",
        "",
        "## Environment",
        "",
        "```json",
        JSON.stringify(report.metadata, null, 2),
        "```",
        ""
    );
    return lines.join("\n");
}

export async function run(config: Config): Promise<{ code: number; directory: string }> {
    const root = path.resolve(
        config.output ?? path.join(repository, "output/playwright/browser-score")
    );
    await fs.mkdir(root, { recursive: true });
    const directory = path.join(
        root,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
    );
    await fs.mkdir(directory); // Never overwrite a previous run.
    const redact = (value: string) =>
        redactText(value, config.proxyUrl, [process.env.CLOAKBROWSER_LICENSE_KEY ?? ""]);
    const writeJson = (name: string, value: unknown) => {
        // Redact strings before JSON encoding so quotes in credentials cannot corrupt the artifact.
        const json = JSON.stringify(
            value,
            (_key, item: unknown) => (typeof item === "string" ? redact(item) : item),
            2
        );
        return fs.writeFile(path.join(directory, name), json);
    };
    const { proxyUrl: _privateProxy, ...publicConfig } = config;
    const metadata: Record<string, unknown> = {
        schemaVersion: 1,
        type: "browser-score",
        startedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        config: publicConfig,
        network: {
            mode: config.network,
            proxyId: config.proxyUrl ? identifier(config.proxyUrl) : null,
        },
        scope: "Browser launch/fingerprint subchain, not the full AnyCrawl Worker. The application variant uses the production launch builder and adapter; other variants use installed CloakBrowser defaults.",
        standards: STANDARDS,
    };
    const report = {
        metadata,
        records: [] as RecordResult[],
        fatalError: undefined as string | undefined,
        exitCode: 2,
    };
    let browser: Browser | undefined;
    try {
        const cloak = await import("cloakbrowser");
        const binary = cloak.binaryInfo(process.env.CLOAKBROWSER_VERSION);
        const override = process.env.CLOAKBROWSER_BINARY_PATH;
        const binaryPath = path.resolve(override || binary.binaryPath);
        await fs.access(binaryPath, constants.X_OK).catch(() => {
            throw new Error(
                "CloakBrowser binary is not installed/executable. Install it explicitly or set CLOAKBROWSER_BINARY_PATH; tests never download a replacement."
            );
        });
        const keyFile = path.join(
            process.env.CLOAKBROWSER_CACHE_DIR || path.join(os.homedir(), ".cloakbrowser"),
            "license.key"
        );
        const hasKeyFile = await fs
            .readFile(keyFile, "utf8")
            .then((value) => Boolean(value.trim()))
            .catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return false;
                throw new Error("Cannot inspect the CloakBrowser license file.");
            });
        if (
            !override &&
            (process.env.CLOAKBROWSER_LICENSE_KEY?.trim() || hasKeyFile) &&
            binary.tier !== "pro"
        )
            throw new Error(
                "A license is configured but no licensed binary is cached. Install the intended binary explicitly; no free-tier fallback was selected."
            );
        process.env.CLOAKBROWSER_AUTO_UPDATE = "false";
        process.env.CLOAKBROWSER_BINARY_PATH = binaryPath;
        metadata.versions = {
            cloakbrowser: packageVersion("cloakbrowser"),
            playwright: packageVersion("playwright"),
            crawlee: packageVersion("crawlee"),
        };
        metadata.binary = {
            path: binaryPath,
            cachedVersion: override ? (process.env.CLOAKBROWSER_VERSION ?? null) : binary.version,
            tier: override ? "explicit-path" : binary.tier,
        };
        metadata.ignoreHTTPSErrors = process.env.ANYCRAWL_IGNORE_SSL_ERROR === "true";
        const launchVersion =
            process.env.CLOAKBROWSER_VERSION || (!override ? binary.version : undefined);
        const needsInjection = config.variants.some(
            (variant) => variant === "inject-only" || variant === "injected-fixed"
        );
        const fingerprintTools = needsInjection
            ? {
                  generator: new (await import("fingerprint-generator")).FingerprintGenerator({
                      browsers: [{ name: "chrome", minVersion: 120 }],
                  }),
                  injector: new (await import("fingerprint-injector")).FingerprintInjector(),
              }
            : undefined;
        if (fingerprintTools)
            Object.assign(metadata.versions as object, {
                fingerprintGenerator: packageVersion("fingerprint-generator"),
                fingerprintInjector: packageVersion("fingerprint-injector"),
            });
        for (let round = 1; round <= config.rounds; round++) {
            const fingerprint = fingerprintTools?.generator.getFingerprint({
                browsers: [{ name: "chrome", minVersion: 120 }],
            });
            if (fingerprint) await writeJson(`fingerprint-r${round}.json`, fingerprint);
            for (const variant of config.variants) {
                let launchOptions: Record<string, any> = {
                    headless: config.headless,
                    proxy: config.proxyUrl,
                    timezone: config.timezone,
                    locale: config.locale,
                    browserVersion: launchVersion,
                    args: [`--fingerprint=${config.seed + round - 1}`],
                    launchOptions: { timeout: config.navigationTimeoutMs },
                };
                if (variant === "application") {
                    const { getBrowserLaunchOptions, shouldResolveBrowserGeoip } = await import(
                        "../../src/core/BrowserLaunchOptions.js"
                    );
                    const { getCloakBrowserPlaywrightLauncher } = await import(
                        "../../src/core/CloakBrowserLauncher.js"
                    );
                    const defaults = getBrowserLaunchOptions();
                    launchOptions = {
                        ...defaults,
                        ...launchOptions,
                        timezone: config.timezone ?? defaults.timezone,
                        locale: config.locale ?? defaults.locale,
                        args: [...(defaults.args as string[]), ...launchOptions.args],
                    };
                    launchOptions.geoip = shouldResolveBrowserGeoip(
                        launchOptions,
                        Boolean(config.proxyUrl)
                    );
                    browser = (await (
                        await getCloakBrowserPlaywrightLauncher()
                    ).launch(launchOptions)) as Browser;
                    metadata.application = {
                        geoip: launchOptions.geoip,
                        timezone: launchOptions.timezone ?? null,
                        locale: launchOptions.locale ?? null,
                    };
                } else browser = await cloak.launch(launchOptions);
                metadata.browserVersion = browser.version();
                for (const site of config.sites) {
                    const stem = `r${round}-${variant}-${site}`;
                    const result: RecordResult = {
                        round,
                        variant,
                        site,
                        status: "unavailable",
                        failures: [],
                        artifacts: {},
                        failedRequests: [],
                    };
                    report.records.push(result);
                    const started = Date.now();
                    let context: BrowserContext | undefined;
                    let page: Page | undefined;
                    let text = "";
                    try {
                        const inject = variant === "inject-only" || variant === "injected-fixed";
                        context = await browser.newContext({
                            ...(variant === "application"
                                ? {}
                                : cloak.buildContextOptions({
                                      headless: config.headless,
                                      browserVersion: launchVersion,
                                  })),
                            ...(inject && fingerprint
                                ? {
                                      userAgent: fingerprint.fingerprint.navigator.userAgent,
                                      viewport: {
                                          width: fingerprint.fingerprint.screen.width,
                                          height: fingerprint.fingerprint.screen.height,
                                      },
                                  }
                                : {}),
                            ignoreHTTPSErrors: process.env.ANYCRAWL_IGNORE_SSL_ERROR === "true",
                        });
                        page = await context.newPage();
                        if (inject && fingerprint && fingerprintTools)
                            await fingerprintTools.injector.attachFingerprintToPlaywright(
                                context,
                                fingerprint
                            );
                        if (variant === "fixed-only" || variant === "injected-fixed")
                            await page.setViewportSize({ width: 1920, height: 1080 });
                        text = await collect(page, site, result, config);
                        result.identity = await identity(page);
                    } catch (error) {
                        result.status = "error";
                        result.error = redact(String(error));
                    } finally {
                        if (page && !page.isClosed()) {
                            try {
                                if (!text)
                                    text = await page.locator("body").innerText({ timeout: 3000 });
                                await fs.writeFile(
                                    path.join(directory, `${stem}.txt`),
                                    redact(text)
                                );
                                result.artifacts.text = `${stem}.txt`;
                                await page.screenshot({
                                    path: path.join(directory, `${stem}.png`),
                                    fullPage: true,
                                    timeout: 15000,
                                });
                                result.artifacts.screenshot = `${stem}.png`;
                            } catch (error) {
                                result.status = "error";
                                result.error = [
                                    result.error,
                                    `Artifact capture: ${redact(String(error))}`,
                                ]
                                    .filter(Boolean)
                                    .join("\n");
                            }
                        }
                        result.elapsedMs = Date.now() - started;
                        result.artifacts.record = `${stem}.json`;
                        await writeJson(`${stem}.json`, result);
                        await writeJson("report.json", report);
                        await context?.close();
                    }
                    console.log(
                        JSON.stringify({
                            round,
                            variant,
                            site,
                            status: result.status,
                            metrics: result.observation?.metrics ?? null,
                            failures: result.failures,
                        })
                    );
                }
                await browser.close();
                browser = undefined;
            }
        }
        const observedIps = report.records
            .map((row) => row.observation?.details.exitIp)
            .filter((ip): ip is string => typeof ip === "string");
        metadata.network = {
            ...(metadata.network as object),
            observedExitIds: [...new Set(observedIps.map(identifier))],
            exitChanged: observedIps.length >= 2 ? new Set(observedIps).size > 1 : null,
            note: "Same configured proxy URL does not prove the same exit IP. Unknown if no detector reported an IP.",
        };
    } catch (error) {
        report.fatalError = redact(String(error));
    } finally {
        try {
            await browser?.close();
        } catch (error) {
            report.fatalError = [report.fatalError, redact(String(error))]
                .filter(Boolean)
                .join("\n");
        }
        metadata.finishedAt = new Date().toISOString();
        report.exitCode = exitCode(report.records, report.fatalError);
        await writeJson("report.json", report);
        await fs.writeFile(path.join(directory, "report.md"), redact(markdown(report)));
    }
    return { code: report.exitCode, directory };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("--list")) {
        console.log("Browser-score live tests (separate from pnpm test).\n");
        for (const [id, standard] of Object.entries(STANDARDS))
            console.log(`${id}: ${standard.description}\n  ${standard.url}`);
        console.log(
            `\nOptions:\n  --sites ${Object.keys(STANDARDS).join(",")}\n  --variants ${VARIANTS.join(",")}\n  --rounds 1 --seed 42069\n  --network configured|direct --proxy-env ANYCRAWL_PROXY_URL --proxy-index 0\n  --headed | --headless\n  --timezone IANA_ZONE --locale en-US --output DIRECTORY\n  --navigation-timeout-ms 45000 --result-timeout-ms 45000\n  --min-authenticity 85 --max-stealth 0 --min-recaptcha 0.5 --require-webdriver\n\nThresholds are optional and apply to every selected variant. No combined human score.\nExit: 0=collected and configured thresholds passed, 1=threshold failure, 2=incomplete/error.`
        );
    } else {
        try {
            const config = parseConfig(args, process.env);
            const outcome = await run(config);
            console.log(`Browser-score report: ${outcome.directory}/report.md`);
            process.exitCode = outcome.code;
        } catch (error) {
            console.error(
                redactText(
                    error instanceof Error ? error.message : "Browser-score configuration failed."
                )
            );
            process.exitCode = 2;
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
