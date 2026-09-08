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

const parsePositiveIntEnv = (key: string, fallback: number): number => {
    const n = parseIntEnv(key, fallback);
    return n > 0 ? n : fallback;
};

const parseMsEnv = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number.parseInt(String(raw), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const config = {
    proxy: {
        get stickyEnabled(): boolean {
            const value = process.env.ANYCRAWL_PROXY_STICKY_ENABLED;
            if (value && value !== "true" && value !== "false") {
                throw new Error("ANYCRAWL_PROXY_STICKY_ENABLED must be true or false");
            }
            return value === "true";
        },
        get stickyTtlSecs(): number | undefined {
            if (!config.proxy.stickyEnabled) return undefined;
            const value = process.env.ANYCRAWL_PROXY_STICKY_TTL_SECS ?? "";
            const seconds = Number(value);
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(seconds) || seconds <= 10 || seconds > 2_147_483) {
                throw new Error("ANYCRAWL_PROXY_STICKY_TTL_SECS must be an integer greater than 10 and at most 2147483 when sticky is enabled");
            }
            return seconds;
        },
    },
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

    monitor: {
        // API preview only; comparison uses complete content retained in the DB.
        get maxInlineContentChars(): number {
            return parsePositiveIntEnv('ANYCRAWL_MONITOR_MAX_INLINE_CHARS', 262_144);
        },
        get maxContentChars(): number { return parsePositiveIntEnv('ANYCRAWL_MONITOR_MAX_CONTENT_CHARS', 2_000_000); },
        get leaseMs(): number { return parsePositiveIntEnv('ANYCRAWL_MONITOR_LEASE_MS', 120_000); },
        get maxAttempts(): number { return parsePositiveIntEnv('ANYCRAWL_MONITOR_MAX_ATTEMPTS', 5); },
        get retryDelayMs(): number { return parsePositiveIntEnv('ANYCRAWL_MONITOR_RETRY_DELAY_MS', 5_000); },
        get pollMs(): number { return parsePositiveIntEnv('ANYCRAWL_MONITOR_POLL_MS', 5_000); },
        // Opt-in: do not erase history merely because an installation upgrades.
        get retentionDays(): number { return Math.max(0, parseIntEnv('ANYCRAWL_MONITOR_RETENTION_DAYS', 0)); },
    },

    email: {
        get enabled(): boolean {
            return !!process.env.ANYCRAWL_SMTP_HOST;
        },
        get host(): string | undefined {
            return process.env.ANYCRAWL_SMTP_HOST;
        },
        get port(): number {
            return parseIntEnv('ANYCRAWL_SMTP_PORT', 587);
        },
        get secure(): boolean {
            return process.env.ANYCRAWL_SMTP_SECURE === "true";
        },
        get user(): string | undefined {
            return process.env.ANYCRAWL_SMTP_USER;
        },
        get pass(): string | undefined {
            return process.env.ANYCRAWL_SMTP_PASS;
        },
        get from(): string {
            return process.env.ANYCRAWL_SMTP_FROM || "AnyCrawl Monitor <no-reply@anycrawl.dev>";
        },
        // Optional List-Unsubscribe target (RFC 2369). The mailbox is handled by
        // the operator's mail infrastructure; AnyCrawl only emits the header.
        get unsubscribeAddress(): string | undefined {
            return process.env.ANYCRAWL_EMAIL_UNSUBSCRIBE_ADDRESS;
        },
        // Optional URL-based unsubscribe target. Enables one-click unsubscribe
        // (RFC 8058) headers when set. Handled by external infrastructure.
        get unsubscribeUrl(): string | undefined {
            return process.env.ANYCRAWL_EMAIL_UNSUBSCRIBE_URL;
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
        get humanize(): boolean {
            // Operator kill switch for the cloakbrowser human-behavior layer.
            // Default enabled (the per-request `humanize` param drives actual behavior;
            // its default "auto" only activates under stealth/retry). Set
            // ANYCRAWL_HUMANIZE=false to hard-disable humanize for every request.
            return process.env.ANYCRAWL_HUMANIZE !== "false";
        },
        get keepAlive(): boolean {
            const raw = process.env.ANYCRAWL_KEEP_ALIVE ?? process.env.ANYCRAWL_KEEPALIVE;
            return raw !== "false";
        },
        get userAgent(): string | undefined {
            return process.env.ANYCRAWL_USER_AGENT;
        },
        get browserGeoip(): boolean {
            return process.env.ANYCRAWL_BROWSER_GEOIP !== "false";
        },
        get browserTimezone(): string | undefined {
            return process.env.ANYCRAWL_BROWSER_TIMEZONE?.trim() || undefined;
        },
        get browserLocale(): string | undefined {
            return process.env.ANYCRAWL_BROWSER_LOCALE?.trim() || undefined;
        },
        get browserIdleRetireSecs(): number {
            return parsePositiveIntEnv('ANYCRAWL_BROWSER_IDLE_RETIRE_SECS', 3600);
        },
        get browserMaxPagesPerBrowser(): number {
            return parsePositiveIntEnv('ANYCRAWL_BROWSER_MAX_PAGES_PER_BROWSER', 500);
        },
        get browserMaxOpenPagesPerBrowser(): number {
            return parsePositiveIntEnv('ANYCRAWL_BROWSER_MAX_OPEN_PAGES_PER_BROWSER', 20);
        },
        get browserIsolateContexts(): boolean {
            return process.env.ANYCRAWL_BROWSER_ISOLATE_CONTEXTS !== "false";
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
