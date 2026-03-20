import { config } from "./config.js";

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse a comma-separated environment variable into a trimmed string array.
 */
export function parseCommaSeparatedEnv(key: string): string[] {
    const value = process.env[key];
    if (!value) return [];
    return value.split(',').map(s => s.trim()).filter(Boolean);
}

/** @deprecated Use `config.auth` instead. */
export const appConfig = {
    get authEnabled(): boolean {
        return config.auth.enabled;
    },
    get creditsEnabled(): boolean {
        return config.auth.creditsEnabled;
    },
};

/**
 * Normalize a proxy URL to ensure it has a scheme prefix.
 */
export function normalizeProxyUrl(input?: string): string | undefined {
    if (!input) return undefined;
    const hasScheme = /^\w+:\/\//.test(input);
    return hasScheme ? input : `http://${input}`;
}

type WaitUntilValue = "networkidle" | "load" | "domcontentloaded";

/**
 * Resolve `wait_until` option into engine-specific values for Playwright and Puppeteer.
 */
export function resolveWaitUntil(raw?: string): {
    configured: string;
    playwright: WaitUntilValue;
    puppeteer: string;
} {
    const configured = String(raw || config.navigation.waitUntil);
    const playwright: WaitUntilValue =
        configured === "networkidle" || configured === "load" || configured === "domcontentloaded"
            ? configured
            : "domcontentloaded";
    let puppeteer: string;
    if (configured === "networkidle") {
        puppeteer = "networkidle0";
    } else if (configured === "load" || configured === "domcontentloaded") {
        puppeteer = configured;
    } else {
        puppeteer = "domcontentloaded";
    }
    return { configured, playwright, puppeteer };
}
