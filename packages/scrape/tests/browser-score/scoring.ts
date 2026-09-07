import { isIP } from "node:net";

export const STANDARDS = {
    browserscan: {
        url: "https://www.browserscan.net/",
        description:
            "Browser fingerprint authenticity (0–100, higher is better); not a human probability.",
        minimumObservationMs: 20_000,
    },
    creepjs: {
        url: "https://abrahamjuliot.github.io/creepjs/",
        description:
            "Separate headless/like-headless/stealth feature percentages; no combined human score.",
        minimumObservationMs: 5_000,
    },
    sannysoft: {
        url: "https://bot.sannysoft.com/",
        description: "Explicit WebDriver checks; no invented numerical score.",
        minimumObservationMs: 3_000,
    },
    recaptcha: {
        url: "https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php",
        description:
            "Server-verified demo action score (0–1); not transferable to another site or Cloudflare.",
        minimumObservationMs: 0,
    },
} as const;

export type Site = keyof typeof STANDARDS;
export interface Observation {
    ready: boolean;
    metrics: Record<string, number | boolean>;
    details: Record<string, unknown>;
    reason?: string;
}
const unavailable = (reason: string): Observation => ({
    ready: false,
    metrics: {},
    details: {},
    reason,
});
const percentage = (text: string, expression: RegExp): number | undefined => {
    const match = text.match(expression);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
};

export function parseObservation(site: Site, text: string, backend?: unknown): Observation {
    if (site === "browserscan") {
        const authenticity = percentage(
            text,
            /Browser fingerprint authenticity:\s*(\d+(?:\.\d+)?)%/i
        );
        const exitIp = text.split(/\s+/).find((token) => isIP(token) !== 0);
        const browser = text.match(/Browser:\s*([^\n]+)/)?.[1]?.trim();
        const bot = text.match(/Bot Detection:\s*((?:No|Yes)(?:\s*Detection)?)/i)?.[1];
        // The static HTML starts at 100% with empty fields. It is not a measurement.
        if (authenticity === undefined || !exitIp || !browser || !/\d/.test(browser) || !bot) {
            return unavailable("BrowserScan results are incomplete or its page format changed.");
        }
        const penalties = [...text.matchAll(/([^\n]+)\n\s*-(\d+(?:\.\d+)?)%/g)].map((match) => ({
            label: match[1]!.trim(),
            deduction: Number(match[2]),
        }));
        return {
            ready: true,
            metrics: { authenticity, botDetected: /^Yes/i.test(bot) },
            details: { browser, exitIp, penalties },
        };
    }
    if (site === "creepjs") {
        const fingerprintId = text.match(/FP ID:\s*([a-f0-9]{32,})\b/i)?.[1];
        const likeHeadless = percentage(text, /(\d+(?:\.\d+)?)% like headless:/i);
        const headless = percentage(text, /(\d+(?:\.\d+)?)% headless:/i);
        const stealth = percentage(text, /(\d+(?:\.\d+)?)% stealth:/i);
        if (
            !fingerprintId ||
            likeHeadless === undefined ||
            headless === undefined ||
            stealth === undefined
        ) {
            return unavailable("CreepJS has not computed its fingerprint and detection metrics.");
        }
        return {
            ready: true,
            metrics: { likeHeadless, headless, stealth },
            details: { fingerprintId },
        };
    }
    if (site === "sannysoft") {
        const compact = text.replace(/\s+/g, " ");
        const webdriver = compact.match(
            /WebDriver\s*\(New\)\s*(missing \(passed\)|present \(failed\))/i
        )?.[1];
        const advanced = compact.match(/WebDriver Advanced\s*(passed|failed)/i)?.[1];
        if (!/Mozilla\/5\.0/.test(compact) || !webdriver || !advanced) {
            return unavailable("Sannysoft has not populated its UA and WebDriver checks.");
        }
        return {
            ready: true,
            metrics: {
                webdriverPassed: /passed/i.test(webdriver),
                advancedPassed: /^passed$/i.test(advanced),
            },
            details: {},
        };
    }
    if (!backend || typeof backend !== "object")
        return unavailable("No reCAPTCHA verification response received.");
    const data = backend as Record<string, unknown>;
    if (
        data.success !== true ||
        typeof data.score !== "number" ||
        !Number.isFinite(data.score) ||
        data.score < 0 ||
        data.score > 1
    ) {
        return unavailable(
            "reCAPTCHA backend did not return success=true with a valid numeric score."
        );
    }
    return {
        ready: true,
        metrics: { score: data.score },
        details: { action: data.action, hostname: data.hostname },
    };
}

export interface Thresholds {
    minAuthenticity?: number;
    maxStealth?: number;
    minRecaptcha?: number;
    requireWebdriver?: boolean;
}
export function thresholdFailures(
    site: Site,
    observation: Observation,
    thresholds: Thresholds
): string[] {
    if (!observation.ready) return ["No valid observation; thresholds cannot pass."];
    const failures: string[] = [];
    const m = observation.metrics;
    const check = (key: string, boundary: number | undefined, direction: "min" | "max") => {
        if (boundary === undefined) return;
        const value = m[key];
        if (typeof value !== "number" || !Number.isFinite(value))
            failures.push(`${key} is unavailable.`);
        else if (direction === "min" ? value < boundary : value > boundary)
            failures.push(`${key} ${value} ${direction === "min" ? "<" : ">"} ${boundary}`);
    };
    if (site === "browserscan") check("authenticity", thresholds.minAuthenticity, "min");
    if (site === "creepjs") check("stealth", thresholds.maxStealth, "max");
    if (site === "recaptcha") check("score", thresholds.minRecaptcha, "min");
    if (
        site === "sannysoft" &&
        thresholds.requireWebdriver &&
        (m.webdriverPassed !== true || m.advancedPassed !== true)
    )
        failures.push("WebDriver checks did not both pass.");
    return failures;
}

export function exitCode(
    records: Array<{ status: string; failures: string[] }>,
    fatalError?: unknown
): number {
    if (
        fatalError ||
        records.length === 0 ||
        records.some((record) => record.status !== "completed")
    )
        return 2;
    return records.some((record) => record.failures.length > 0) ? 1 : 0;
}
