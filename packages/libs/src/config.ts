/**
 * Unified runtime configuration for the AnyCrawl platform.
 *
 * All shared environment variables are read lazily via getters so that
 * tests can override `process.env` values after import time.
 */

const parseIntEnv = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
};

const parseMsEnv = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number.parseInt(String(raw), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const config = {
    auth: {
        get enabled(): boolean {
            return process.env.ANYCRAWL_API_AUTH_ENABLED === "true";
        },
        get creditsEnabled(): boolean {
            return process.env.ANYCRAWL_API_CREDITS_ENABLED === "true";
        },
    },

    api: {
        get port(): string {
            return process.env.ANYCRAWL_API_PORT || "8080";
        },
        get domain(): string | undefined {
            return process.env.ANYCRAWL_DOMAIN;
        },
    },

    search: {
        get defaultEngine(): string | undefined {
            return process.env.ANYCRAWL_SEARCH_DEFAULT_ENGINE;
        },
        get enabledEngines(): string[] | undefined {
            const raw = process.env.ANYCRAWL_SEARCH_ENABLED_ENGINES;
            if (!raw) return undefined;
            return raw.split(',').map(e => e.trim()).filter(Boolean);
        },
        get searxngUrl(): string | undefined {
            return process.env.ANYCRAWL_SEARXNG_URL;
        },
        get acEngineUrl(): string | undefined {
            return process.env.ANYCRAWL_AC_ENGINE_URL;
        },
    },

    scheduler: {
        get enabled(): boolean {
            return process.env.ANYCRAWL_SCHEDULER_ENABLED === "true";
        },
        get syncIntervalMs(): number {
            return parseIntEnv('ANYCRAWL_SCHEDULER_SYNC_INTERVAL_MS', 10_000);
        },
        get limitEnabled(): boolean {
            return process.env.ANYCRAWL_SCHEDULED_TASKS_LIMIT_ENABLED === "true";
        },
        get limitFree(): number {
            return parseIntEnv('ANYCRAWL_SCHEDULED_TASKS_LIMIT_FREE', 1);
        },
        get limitPaid(): number {
            return parseIntEnv('ANYCRAWL_SCHEDULED_TASKS_LIMIT_PAID', 100);
        },
    },

    webhooks: {
        get enabled(): boolean {
            return process.env.ANYCRAWL_WEBHOOKS_ENABLED === "true";
        },
    },

    navigation: {
        get timeoutMs(): number {
            return parseIntEnv('ANYCRAWL_NAV_TIMEOUT', 30_000);
        },
        get waitUntil(): string {
            return process.env.ANYCRAWL_NAV_WAIT_UNTIL || "domcontentloaded";
        },
        get requestHandlerTimeoutSecs(): number {
            return parseIntEnv('ANYCRAWL_REQUEST_HANDLER_TIMEOUT_SECS', 600);
        },
    },

    engine: {
        get ignoreSSLError(): boolean {
            return process.env.ANYCRAWL_IGNORE_SSL_ERROR === "true";
        },
        get headless(): boolean {
            return process.env.ANYCRAWL_HEADLESS !== "false";
        },
        get lightMode(): boolean {
            return process.env.ANYCRAWL_LIGHT_MODE !== "false";
        },
        get keepAlive(): boolean {
            return process.env.ANYCRAWL_KEEP_ALIVE !== "false";
        },
        get userAgent(): string | undefined {
            return process.env.ANYCRAWL_USER_AGENT;
        },
        get minConcurrency(): number | undefined {
            const raw = process.env.ANYCRAWL_MIN_CONCURRENCY;
            if (!raw) return undefined;
            const n = parseInt(raw, 10);
            return Number.isFinite(n) ? n : undefined;
        },
        get maxConcurrency(): number | undefined {
            const raw = process.env.ANYCRAWL_MAX_CONCURRENCY;
            if (!raw) return undefined;
            const n = parseInt(raw, 10);
            return Number.isFinite(n) ? n : undefined;
        },
    },

    cache: {
        get enabled(): boolean {
            return process.env.ANYCRAWL_CACHE_ENABLED !== "false";
        },
        get storageIsS3(): boolean {
            return process.env.ANYCRAWL_STORAGE === "s3";
        },
        get pageCacheEnabled(): boolean {
            return this.storageIsS3 && this.enabled;
        },
        get mapCacheEnabled(): boolean {
            return this.enabled;
        },
        get defaultMaxAgeMs(): number {
            return parseMsEnv('ANYCRAWL_CACHE_DEFAULT_MAX_AGE', 2 * 24 * 60 * 60 * 1000);
        },
        get sitemapMaxAgeMs(): number {
            return parseMsEnv('ANYCRAWL_CACHE_SITEMAP_MAX_AGE', 7 * 24 * 60 * 60 * 1000);
        },
    },

    redis: {
        get url(): string {
            return process.env.ANYCRAWL_REDIS_URL || "";
        },
    },
};
