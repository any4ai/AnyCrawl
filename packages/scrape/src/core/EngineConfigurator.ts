import { AD_DOMAINS, log } from "@anycrawl/libs";
import { minimatch } from "minimatch";
import { Utils } from "../Utils.js";
import { BrowserName } from "crawlee";
import { ProgressManager } from "../managers/Progress.js";
import { JOB_TYPE_CRAWL } from "@anycrawl/libs";
import { CrawlLimitReachedError } from "../errors/index.js";
import { getOrCreateBandwidthTracker } from "./BandwidthTracker.js";
import { CloudflareChallengeHandler } from "../challenges/cloudflare/CloudflareChallengeHandler.js";
import { ChallengeOrchestrator } from "../challenges/ChallengeOrchestrator.js";

export enum ConfigurableEngineType {
    CHEERIO = 'cheerio',
    PLAYWRIGHT = 'playwright',
    PUPPETEER = 'puppeteer'
}

/**
 * Engine configurator for applying engine-specific settings
 * Separates configuration logic from the main engine
 */
export class EngineConfigurator {
    /**
     * Apply engine-specific configurations
     */
    static configure(crawlerOptions: any, engineType: ConfigurableEngineType): any {
        const options = { ...crawlerOptions };

        // Apply common autoscaled pool options
        if (!options.autoscaledPoolOptions) {
            options.autoscaledPoolOptions = {
                isFinishedFunction: async () => false,
            };
        }

        // Apply browser-specific configurations
        if (this.isBrowserEngine(engineType)) {
            this.configureBrowserEngine(options, engineType);
        }

        // Apply engine-specific configurations
        switch (engineType) {
            case ConfigurableEngineType.PUPPETEER:
                this.configurePuppeteer(options);
                break;
            case ConfigurableEngineType.PLAYWRIGHT:
                this.configurePlaywright(options);
                break;
            case ConfigurableEngineType.CHEERIO:
                this.configureCheerio(options);
                break;
        }

        // Apply common hooks for ALL engines (including Cheerio)
        this.applyCommonHooks(options, engineType);

        return options;
    }

    /**
     * Apply common hooks for ALL engines (including Cheerio)
     */
    private static applyCommonHooks(options: any, engineType: ConfigurableEngineType): void {
        // Limit filter hook - abort requests that exceed crawl limit
        const limitFilterHook = async ({ request }: any) => {
            try {
                const userData: any = request.userData || {};
                const jobId = userData?.jobId;

                log.debug(`[limitFilterHook] Hook executed for request: ${request.url}, jobId: ${jobId}, type: ${userData.type}`);

                // Only apply limit filtering to crawl jobs
                if (jobId && userData.type === JOB_TYPE_CRAWL) {
                    log.debug(`[limitFilterHook] [${userData.queueName}] [${jobId}] Processing crawl job with limit filtering`);

                    const pm = ProgressManager.getInstance();
                    const limit = userData.crawl_options?.limit || 10;

                    log.debug(`[limitFilterHook] [${userData.queueName}] [${jobId}] Fetching progress data: limit=${limit}`);

                    // Get current progress
                    const [enqueued, done, finalized, cancelled] = await Promise.all([
                        pm.getEnqueued(jobId),
                        pm.getDone(jobId),
                        pm.isFinalized(jobId),
                        pm.isCancelled(jobId),
                    ]);

                    log.debug(`[limitFilterHook] [${userData.queueName}] [${jobId}] Progress data: enqueued=${enqueued}, done=${done}, finalized=${finalized}, cancelled=${cancelled}`);

                    // Check if we should abort this request
                    // Only abort if:
                    // 1. Job is finalized or cancelled
                    // 2. We've already completed enough pages (done >= limit)
                    if (finalized || cancelled || done >= limit) {
                        const reason = finalized ? 'finalized' :
                            cancelled ? 'cancelled' :
                                done >= limit ? 'limit reached' :
                                    'excessive queuing';

                        log.info(`[limitFilterHook] [${userData.queueName}] [${jobId}] ABORTING request - ${reason} (processed=${done}, enqueued=${enqueued}, limit=${limit})`);

                        // If we've reached the limit, try to finalize the job immediately
                        if (done >= limit && !finalized && !cancelled) {
                            log.info(`[limitFilterHook] [${userData.queueName}] [${jobId}] Attempting to finalize job after reaching limit (${done}/${limit})`);
                            try {
                                // Force finalize with the current limit value
                                const finalizeResult = await pm.tryFinalize(jobId, userData.queueName, {}, limit);
                                if (finalizeResult) {
                                    log.info(`[limitFilterHook] [${userData.queueName}] [${jobId}] Job finalized successfully after reaching limit`);
                                } else {
                                    log.warning(`[limitFilterHook] [${userData.queueName}] [${jobId}] Job finalization failed - may need manual intervention`);
                                }
                            } catch (finalizeError) {
                                log.warning(`[limitFilterHook] [${userData.queueName}] [${jobId}] Failed to finalize job after reaching limit: ${finalizeError}`);
                            }
                        }

                        log.debug(`[limitFilterHook] [${userData.queueName}] [${jobId}] Throwing CrawlLimitReachedError to prevent navigation`);

                        // Throw specialized error to abort the navigation and avoid proxy consumption
                        throw new CrawlLimitReachedError(jobId, reason, limit, done);
                    }

                    log.debug(`[limitFilterHook] [${userData.queueName}] [${jobId}] Request allowed to proceed - all checks passed`);
                } else {
                    log.debug(`[limitFilterHook] Skipping limit filtering - not a crawl job: jobId=${jobId}, type=${userData.type}`);
                }
            } catch (error) {
                // Re-throw CrawlLimitReachedError to abort navigation
                if (error instanceof CrawlLimitReachedError) {
                    log.debug(`[limitFilterHook] Re-throwing CrawlLimitReachedError: ${error.message}`);
                    throw error;
                }
                // Log and ignore other errors to avoid breaking navigation
                log.error(`[limitFilterHook] Unexpected error in limit filter hook: ${error}`);
            }
        };

        // Merge with existing preNavigationHooks
        const existingHooks = options.preNavigationHooks || [];

        options.preNavigationHooks = [limitFilterHook, ...existingHooks];

        log.debug(`[EngineConfigurator] Pre-navigation hooks configured for ${engineType}: total=${options.preNavigationHooks.length}, limitFilterHook=${options.preNavigationHooks.includes(limitFilterHook)}, existingHooks=${existingHooks.length}`);
    }

    private static isBrowserEngine(engineType: ConfigurableEngineType): boolean {
        return engineType === ConfigurableEngineType.PLAYWRIGHT ||
            engineType === ConfigurableEngineType.PUPPETEER;
    }

    private static configureBrowserEngine(options: any, engineType: ConfigurableEngineType): void {
        // Enforce viewport for browser engines
        const viewportHook = async ({ page }: any) => {
            try {
                if (!page) return;
                if ((page as any).__viewportApplied) return;
                (page as any).__viewportApplied = true;
                if (engineType === ConfigurableEngineType.PLAYWRIGHT) {
                    await page.setViewportSize({ width: 1920, height: 1080 });
                } else if (engineType === ConfigurableEngineType.PUPPETEER) {
                    try { await page.setViewport({ width: 1920, height: 1080 }); } catch { }
                }
            } catch { }
        };

        const bandwidthHook = async ({ page, request }: any) => {
            try {
                const jobId = request?.userData?.jobId;
                if (!jobId || !page) return;
                const tracker = await getOrCreateBandwidthTracker(page, engineType);
                tracker?.setJobContext(String(jobId));
            } catch {
                // ignore bandwidth tracking errors
            }
        };

        // Ad blocking configuration
        const adBlockingHook = async ({ page }: any) => {
            const shouldBlock = (url: string) => AD_DOMAINS.some(domain => url.includes(domain));

            if (engineType === ConfigurableEngineType.PLAYWRIGHT) {
                await page.route('**/*', (route: any) => {
                    const url = route.request().url();
                    if (shouldBlock(url)) {
                        log.info(`Aborting request to ${url}`);
                        return route.abort();
                    }
                    return route.continue();
                });
            } else if (engineType === ConfigurableEngineType.PUPPETEER) {
                await page.setRequestInterception(true);
                page.on('request', (req: any) => {
                    const url = req.url();
                    if (shouldBlock(url)) {
                        log.info(`Aborting request to ${url}`);
                        req.abort();
                    } else {
                        req.continue();
                    }
                });
            }
        };

        // set request timeout and faster navigation for each request
        const requestTimeoutHook = async ({ request }: any, gotoOptions: any) => {
            const timeoutMs = request.userData.options.timeout || (process.env.ANYCRAWL_NAV_TIMEOUT ? parseInt(process.env.ANYCRAWL_NAV_TIMEOUT) : 30_000);
            const waitUntil = (request.userData.options.wait_until || process.env.ANYCRAWL_NAV_WAIT_UNTIL || 'domcontentloaded') as any;
            log.debug(`Setting navigation for ${request.url} to timeout=${timeoutMs}ms waitUntil=${waitUntil}`);
            gotoOptions.timeout = timeoutMs;
            gotoOptions.waitUntil = waitUntil;
        };

        // Handle authentication to allow accessing 401 pages
        const authenticationHook = async ({ page }: any) => {
            if (engineType === ConfigurableEngineType.PUPPETEER) {
                try {
                    // First, set authenticate to null
                    await page.authenticate(null);

                    // Then use CDP to handle auth challenges
                    const client = await page.target().createCDPSession();

                    // Enable Fetch domain to intercept auth challenges
                    await client.send('Fetch.enable', {
                        handleAuthRequests: true,
                        patterns: [{ urlPattern: '*' }]
                    });

                    // Listen for auth required events
                    client.on('Fetch.authRequired', async (event: any) => {
                        log.debug(`Auth challenge intercepted for: ${event.request.url}`);

                        // Continue without auth to see 401 page content
                        try {
                            await client.send('Fetch.continueWithAuth', {
                                requestId: event.requestId,
                                authChallengeResponse: {
                                    response: 'CancelAuth'
                                }
                            });
                        } catch (err) {
                            log.debug(`Failed to cancel auth: ${err}`);
                            // Try to continue the request anyway
                            try {
                                await client.send('Fetch.continueRequest', {
                                    requestId: event.requestId
                                });
                            } catch (e) {
                                log.debug(`Failed to continue request: ${e}`);
                            }
                        }
                    });

                    // Also handle request paused events
                    client.on('Fetch.requestPaused', async (event: any) => {
                        // Continue all paused requests
                        try {
                            await client.send('Fetch.continueRequest', {
                                requestId: event.requestId
                            });
                        } catch (e) {
                            log.debug(`Failed to continue paused request: ${e}`);
                        }
                    });

                    log.debug('CDP auth handling enabled for Puppeteer');
                } catch (e) {
                    log.debug(`Failed to set up auth handling: ${e}`);
                }
            } else if (engineType === ConfigurableEngineType.PLAYWRIGHT) {
                // For Playwright, we might need different handling
                // Currently Playwright handles this better by default
            }
        };

        const challengeOrchestrator = new ChallengeOrchestrator([
            new CloudflareChallengeHandler(),
        ]);
        const challengePreHook = async (args: any) => {
            if (args?.request) {
                (args.request as any).__anycrawlChallengeOrchestrator = challengeOrchestrator;
            }
            await challengeOrchestrator.onPreNavigation(args);
        };

        // Pre-navigation capture hook for preNav rules
        const preNavHook = async ({ page, request }: any) => {
            try {
                log.debug(`[preNavHook] called with page=${!!page}, request=${!!request}, url=${request?.url}`);
                if (!page || !request) {
                    log.warning(`[preNavHook] missing page or request, skipping`);
                    return;
                }
                const templateId = request.userData?.options?.template_id || request.userData?.templateId;
                log.debug(`[preNavHook] templateId=${templateId}, url=${request.url}`);
                if (!templateId) {
                    log.debug(`[preNavHook] no templateId found, skipping preNav setup`);
                    return;
                }

                // Load template to read preNav rules
                let template: any = null;
                try {
                    const { TemplateClient } = await import('@anycrawl/template-client');
                    const tc = new TemplateClient();
                    template = await tc.getTemplate(templateId);
                    log.debug(`[preNavHook] template loaded successfully: ${templateId}`);
                } catch (e) {
                    log.error(`[preNavHook] failed to load template ${templateId}: ${e}`);
                    return;
                }
                const preNav = template?.customHandlers?.preNav;
                if (!Array.isArray(preNav) || preNav.length === 0) {
                    log.debug(`[preNav] disabled or empty for templateId=${templateId} url=${request.url}`);
                    return;
                }

                type Rule = { type: 'exact' | 'glob' | 'regex'; pattern: string; re?: RegExp };
                type KeyCfg = { key: string; rules: Rule[]; done: boolean };

                const keyCfgs: KeyCfg[] = preNav.map((cfg: any) => ({
                    key: String(cfg?.key ?? ''),
                    rules: Array.isArray(cfg?.rules) ? cfg.rules.map((r: any) => {
                        const type = r?.type;
                        const pattern = String(r?.pattern ?? '');
                        if (type === 'regex') {
                            let re: RegExp | undefined;
                            try { re = new RegExp(`^(?:${pattern})$`); } catch { re = undefined; }
                            return { type: 'regex', pattern, re } as Rule;
                        }
                        if (type === 'glob') return { type: 'glob', pattern } as Rule;
                        return { type: 'exact', pattern } as Rule;
                    }) : [],
                    done: false,
                })).filter(k => k.key && k.rules.length > 0);

                if (keyCfgs.length === 0) {
                    log.debug(`[preNav] no valid rules after parsing for templateId=${templateId}`);
                    return;
                }

                const redis = Utils.getInstance().getRedisConnection();
                const jobId = request.userData?.jobId || 'unknown';
                const requestId = request.uniqueKey || `${Date.now()}`;
                console.log(`[preNav] enabled! jobId=${jobId}, requestId=${requestId}, keys=[${keyCfgs.map(k => k.key).join(', ')}]`);
                log.debug(`[preNav] enabled templateId=${templateId} jobId=${jobId} requestId=${requestId} keys=[${keyCfgs.map(k => k.key).join(', ')}]`);

                const matchUrl = (url: string, rules: Rule[]): boolean => {
                    for (const r of rules) {
                        if (r.type === 'exact') {
                            if (url === r.pattern) return true;
                        } else if (r.type === 'glob') {
                            try { if (minimatch(url, r.pattern, { dot: true })) return true; } catch { /* ignore */ }
                        } else if (r.type === 'regex') {
                            if (r.re && r.re.test(url)) return true;
                        }
                    }
                    return false;
                };

                // Response listener: match URL and capture payload
                const onResponse = async (response: any) => {
                    try {
                        const url = typeof response.url === 'function' ? response.url() : (response.url || '');
                        if (!url) return;
                        const verbose = process.env.ANYCRAWL_PRENAV_VERBOSE === '1' || process.env.ANYCRAWL_PRENAV_VERBOSE === 'true';

                        // Only continue (and optionally log) if the URL matches at least one pending rule
                        // or verbose mode is explicitly enabled
                        const candidate = keyCfgs.some(k => !k.done && matchUrl(url, k.rules));
                        if (!candidate && !verbose) return;
                        if (verbose) {
                            const pending = keyCfgs.filter(k => !k.done).length;
                            log.debug(`[preNav] response url=${url} pendingKeys=${pending}`);
                        }

                        // Find first not-done key that matches
                        for (const cfg of keyCfgs) {
                            if (cfg.done) continue;
                            if (!matchUrl(url, cfg.rules)) continue;
                            log.debug(`[preNav] matched key=${cfg.key} url=${url}`);

                            // Collect response metadata
                            let status = 0;
                            try { status = typeof response.status === 'function' ? response.status() : (response.status || 0); } catch { }
                            let headers: Record<string, string> = {};
                            try { headers = typeof response.headers === 'function' ? (await response.headers()) : (response.headers || {}); } catch { }
                            const lowerHeaders: Record<string, string> = {};
                            for (const [k, v] of Object.entries(headers || {})) lowerHeaders[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);

                            // Always capture text body
                            let body: string | undefined = undefined;
                            try {
                                body = await response.text();
                            } catch { /* ignore body parse errors */ }

                            // If body is empty (including content-length: 0), skip capturing for this response
                            const contentLengthHeader = (lowerHeaders as any)['content-length'];
                            let reportedLength = 0;
                            try { reportedLength = contentLengthHeader ? parseInt(String(contentLengthHeader)) : 0; } catch { reportedLength = 0; }
                            const hasBody = (typeof body === 'string' && body.length > 0) || reportedLength > 0;
                            if (!hasBody) {
                                log.debug(`[preNav] empty body, skip capture key=${cfg.key} url=${url}`);
                                continue;
                            }

                            // Cookies snapshot (raw from engine, no normalization for now)
                            let cookiesRaw: any[] = [];
                            try {
                                const ctx = typeof page.context === 'function' ? page.context() : undefined;
                                if (ctx && typeof ctx.cookies === 'function') {
                                    cookiesRaw = await ctx.cookies(url);
                                } else if (typeof page.cookies === 'function') {
                                    cookiesRaw = await page.cookies(url);
                                }
                            } catch { /* ignore */ }

                            // Raw Set-Cookie header values (no parsing)
                            const setCookieHeader = (headers as any)?.['set-cookie'] ?? (lowerHeaders as any)['set-cookie'];
                            const setCookieRaw: string[] = Array.isArray(setCookieHeader)
                                ? setCookieHeader as string[]
                                : (typeof setCookieHeader === 'string' ? [setCookieHeader] : []);

                            // Method
                            let method: string | undefined = undefined;
                            try { const req = typeof response.request === 'function' ? response.request() : undefined; method = req && typeof req.method === 'function' ? req.method() : undefined; } catch { }

                            const payload = {
                                key: cfg.key,
                                url,
                                method,
                                status,
                                headers: lowerHeaders,
                                body,
                                matchedAt: Date.now(),
                                cookiesRaw,
                                setCookieRaw,
                            };

                            const ns = `${jobId}:${requestId}:${cfg.key}`;
                            const dataKey = `prenav:data:${ns}`;
                            const sigKey = `prenav:sig:${ns}`;
                            try {
                                const payloadStr = JSON.stringify(payload);
                                log.debug(`[preNav] storing payload for key=${cfg.key}, dataKey=${dataKey}, payload size=${payloadStr.length}, keys=${Object.keys(payload).join(',')}`);
                                log.debug(`[preNav] payload preview: ${payloadStr.substring(0, 300)}`);
                                const res = await (redis as any).set(dataKey, payloadStr, 'EX', 1800);
                                log.debug(`[preNav] redis.set result=${res} for dataKey=${dataKey}`);
                                if (res === 'OK') {
                                    log.debug(`[preNav] redis.lpush sigKey=${sigKey}`);
                                    await (redis as any).lpush(sigKey, '1');
                                    log.info(`[preNav] ✓ Successfully captured and stored data for key=${cfg.key}, url=${url}`);
                                } else {
                                    log.warning(`[preNav] redis.set returned ${res} instead of OK for key=${cfg.key}`);
                                }
                            } catch (e) {
                                log.error(`[preNav] redis error for key=${cfg.key}: ${e instanceof Error ? e.message : String(e)}`);
                            }

                            cfg.done = true;
                        }

                        // If all done, cleanup
                        if (keyCfgs.every(k => k.done)) {
                            log.debug(`[preNav] all keys satisfied, cleaning up listeners`);
                            try { page.off('response', onResponse); } catch { }
                        }
                    } catch (err) {
                        log.error(`[preNav] onResponse error: ${err instanceof Error ? err.message : String(err)}`);
                    }
                };

                page.on('response', onResponse);
                log.debug(`[preNavHook] response listener attached successfully`);
                page.once('close', () => {
                    log.debug(`[preNav] page closed, cleaning up listeners`);
                    try { page.off('response', onResponse); } catch { }
                });
            } catch (err) {
                log.error(`[preNavHook] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
                log.error(`[preNavHook] stack: ${err instanceof Error ? err.stack : 'N/A'}`);
            }
        };

        const challengePostHook = async (args: any) => {
            await challengeOrchestrator.onPostNavigation(args);
        };

        // Add browser-specific hooks to preNavigationHooks
        const existingHooks = options.preNavigationHooks || [];
        options.preNavigationHooks = [
            viewportHook,
            bandwidthHook,
            adBlockingHook,
            requestTimeoutHook,
            authenticationHook,
            challengePreHook,
            preNavHook,
            ...existingHooks
        ];

        log.info(`[EngineConfigurator] Browser hooks configured for ${engineType}: total=${options.preNavigationHooks.length}`);

        const existingPostHooks = options.postNavigationHooks || [];
        options.postNavigationHooks = [challengePostHook, ...existingPostHooks];
        log.info(`[EngineConfigurator] Post-navigation hooks configured for ${engineType}: total=${options.postNavigationHooks.length}`);

        // Apply headless configuration from environment
        if (options.headless === undefined) {
            options.headless = process.env.ANYCRAWL_HEADLESS !== "false";
        }

        // Let 403 pages reach requestHandler; do not fail early in Crawlee blocked-page detection.
        options.retryOnBlocked = false;

        options.maxRequestRetries = 3;
        options.maxSessionRotations = 3; // Enable session rotation

        // Configure session pool with specific settings
        if (options.useSessionPool !== false) {
            const configuredBlockedStatusCodes = Array.isArray(options.sessionPoolOptions?.blockedStatusCodes)
                ? options.sessionPoolOptions.blockedStatusCodes
                : [401, 403, 429];
            const normalizedBlockedStatusCodes = configuredBlockedStatusCodes
                .filter((code: any) => Number.isFinite(code))
                .map((code: any) => Number(code))
                .filter((code: number) => code !== 403);

            options.sessionPoolOptions = {
                ...options.sessionPoolOptions,
                // Keep blocked-status handling for other protection codes, but never block on 403.
                blockedStatusCodes: normalizedBlockedStatusCodes,
                // Configure session options to rotate after every error
                sessionOptions: {
                    ...options.sessionPoolOptions?.sessionOptions,
                    maxErrorScore: options.sessionPoolOptions?.sessionOptions?.maxErrorScore ?? 1,
                },
            };
            log.info(`[EngineConfigurator] SessionPool blockedStatusCodes for ${engineType}: [${normalizedBlockedStatusCodes.join(", ")}] (403 excluded)`);
        }
        const isTimeoutLikeError = (error: Error): boolean => {
            const errorName = error?.name || (error as any)?.constructor?.name;
            return errorName === "TimeoutError";
        };

        // Configure how errors are evaluated
        options.errorHandler = async (context: any, error: Error) => {
            log.debug(`Error handler triggered: ${error.message}`);

            // Handle CrawlLimitReachedError specially - log as INFO instead of ERROR
            if (error instanceof CrawlLimitReachedError) {
                log.info(`[EXPECTED] Crawl limit reached for job ${error.jobId}: ${error.reason} - continuing with processed pages`);
                return false; // Don't retry, don't mark as failed
            }

            // Check error type and determine retry strategy
            const errorMessage = error.message || '';

            if (
                errorMessage.includes("ANYCRAWL_PROXY_ACTION_UPGRADE_TO_STEALTH")
                || errorMessage.includes("ANYCRAWL_PROXY_UPGRADE_TO_STEALTH")
            ) {
                if (context?.request) {
                    context.request.noRetry = false;
                }
                log.info(`Proxy upgrade marker detected, retrying with stealth proxy for ${context?.request?.url || "unknown url"}`);
                return true;
            }

            if (
                errorMessage.includes("ANYCRAWL_PROXY_ACTION_ROTATE_PROXY")
                || errorMessage.includes("ANYCRAWL_STEALTH_RETRY_WITH_NEW_PROXY")
            ) {
                if (context?.request) {
                    context.request.noRetry = false;
                }
                log.info(`Challenge retry marker detected, retrying with rotated proxy for ${context?.request?.url || "unknown url"}`);
                return true;
            }

            if (errorMessage.includes("Received blocked status code: 403")) {
                if (context?.request) {
                    context.request.noRetry = true;
                }
                log.info(`403 blocked-status session error detected, disabling retry for ${context?.request?.url || "unknown url"}`);
                return false;
            }

            // Timeout-like errors should fail fast and never retry.
            // Crawlee ignores the return value of errorHandler, so we need to set request.noRetry explicitly.
            if (isTimeoutLikeError(error)) {
                if (context?.request) {
                    context.request.noRetry = true;
                }
                log.info(`Timeout-like error detected, disabling retry for ${context?.request?.url || "unknown url"}`);
                return false;
            }

            // Proxy-related errors that might be temporary
            const temporaryProxyErrors = [
                'ERR_PROXY_CONNECTION_FAILED',
                'ERR_TUNNEL_CONNECTION_FAILED',
                'ERR_PROXY_AUTH_FAILED',
                'ERR_NEED_TO_RETRY',
                'ERR_SOCKS_CONNECTION_FAILED'
            ];

            if (temporaryProxyErrors.some(err => errorMessage.includes(err))) {
                log.debug('Temporary proxy error detected, allowing retry with session rotation');
                return true; // Retry with new session
            }

            // For all other errors, don't retry
            log.debug('Unknown error type, not retrying');
            return false;
        };
    }

    private static configurePuppeteer(options: any): void {
        options.browserPoolOptions = {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: [{ name: BrowserName.chrome, minVersion: 120 }],
                },
            },
        };
    }

    private static configurePlaywright(options: any): void {
        options.browserPoolOptions = {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: [{ name: BrowserName.chrome, minVersion: 120 }],
                },
            },
        };
    }

    private static configureCheerio(options: any): void {
        // Cheerio-specific configurations can be added here
    }
}
