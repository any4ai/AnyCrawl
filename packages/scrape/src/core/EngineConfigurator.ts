import { AD_DOMAINS, log } from "@anycrawl/libs";
import { BrowserName } from "crawlee";
import { ProgressManager } from "../managers/Progress.js";
import { JOB_TYPE_CRAWL } from "../constants.js";
import { CrawlLimitReachedError } from "../errors/index.js";

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
            const waitUntil = (request.userData.options.waitUntil || process.env.ANYCRAWL_NAV_WAIT_UNTIL || 'domcontentloaded') as any;
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

        // Add browser-specific hooks to preNavigationHooks
        const existingHooks = options.preNavigationHooks || [];
        options.preNavigationHooks = [adBlockingHook, requestTimeoutHook, authenticationHook, ...existingHooks];

        log.debug(`[EngineConfigurator] Browser-specific hooks configured for ${engineType}: total=${options.preNavigationHooks.length}, existingHooks=${existingHooks.length}`);

        // Apply headless configuration from environment
        if (options.headless === undefined) {
            options.headless = process.env.ANYCRAWL_HEADLESS !== "false";
        }

        // Configure retry behavior - disable automatic retries for blocked pages
        options.retryOnBlocked = true;

        options.maxRequestRetries = 3;
        options.maxSessionRotations = 3; // Enable session rotation

        // Configure session pool with specific settings
        if (options.useSessionPool !== false) {
            options.sessionPoolOptions = {
                ...options.sessionPoolOptions,
                // Specify which status codes should NOT trigger session rotation
                // This allows us to capture these status codes while still rotating for other errors
                blockedStatusCodes: [], // Only these codes will trigger rotation
            };


        }
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

            // Proxy-related errors that might be temporary
            const temporaryProxyErrors = [
                'ERR_PROXY_CONNECTION_FAILED',
                'ERR_TUNNEL_CONNECTION_FAILED',
                'ERR_PROXY_AUTH_FAILED',
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
        // Puppeteer-specific configurations can be added here
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
        // Playwright-specific configurations can be added here
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