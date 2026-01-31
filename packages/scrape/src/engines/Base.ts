import { BrowserCrawlingContext, CheerioCrawlingContext, Configuration, enqueueLinks, log, PlaywrightCrawlingContext, ProxyConfiguration, PuppeteerCrawlingContext, RequestQueue, sleep, Request } from "crawlee";
import { Dictionary } from "crawlee";
import { Utils } from "../Utils.js";
import { ConfigValidator } from "../core/ConfigValidator.js";
import { DataExtractor } from "../core/DataExtractor.js";
import { ExtractionError } from "../core/DataExtractor.js";
import { JobManager } from "../core/JobManager.js";
import { EngineConfigurator, ConfigurableEngineType } from "../core/EngineConfigurator.js";
import {
    HttpStatusCategory,
    CrawlerErrorType,
    CrawlerError,
    ResponseStatus,
    CrawlerResponse
} from "../types/crawler.js";
import { insertJobResult, failedJob, completedJob } from "@anycrawl/db";
import { JOB_RESULT_STATUS } from "../../../db/dist/map.js";
import { ProgressManager } from "../managers/Progress.js";
import { JOB_TYPE_CRAWL, JOB_TYPE_SCRAPE } from "@anycrawl/libs";
import type { RequestTrafficMetric } from "@anycrawl/libs";
import { CrawlLimitReachedError } from "../errors/index.js";
import type { CrawlingContext, EngineOptions } from "../types/engine.js";
import { minimatch } from "minimatch";
import { BandwidthManager } from "../managers/Bandwidth.js";
import { getResolvedProxyModeName } from "../managers/Proxy.js";

// Template system imports - directly use @anycrawl/template-client

// Re-export core types for backward compatibility
export type { MetadataEntry, BaseContent } from "../core/DataExtractor.js";
export { ExtractionError } from "../core/DataExtractor.js";
export { ConfigurableEngineType as BaseEngineType } from "../core/EngineConfigurator.js";

// Re-export types from the dedicated types file
export type { CrawlingContext, EngineOptions } from "../types/engine.js";

/**
 * Lightweight BaseEngine abstract class
 * Delegates responsibilities to specialized classes
 */
export abstract class BaseEngine {
    protected options: EngineOptions = {};
    protected queue: RequestQueue | undefined = undefined;
    protected abstract engine: any;
    protected abstract isInitialized: boolean;

    // Composition over inheritance - use specialized classes
    protected dataExtractor = new DataExtractor();
    protected jobManager = new JobManager();

    // Template client for handling template-based requests
    protected templateClient: any = null;

    /**
     * Determine if the status code falls within a specific category
     * @param status - Response status object
     * @param category - Base category number (e.g., 200 for success, 400 for client error)
     * @returns true if status code is within the category range (category to category+99)
     */
    protected isStatusInCategory(status: ResponseStatus, category: HttpStatusCategory): boolean {
        return status.statusCode >= category && status.statusCode < category + 100;
    }

    /**
     * Check if the response indicates a successful request
     * Status code range: 200-299
     * Common codes:
     * - 200: OK
     * - 201: Created
     * - 204: No Content
     */
    protected isSuccessfulResponse(status: ResponseStatus): boolean {
        return this.isStatusInCategory(status, HttpStatusCategory.SUCCESS);
    }

    /**
     * Check if the response indicates a client error
     * Status code range: 400-499
     * Common codes:
     * - 400: Bad Request
     * - 401: Unauthorized
     * - 403: Forbidden
     * - 404: Not Found
     * - 429: Too Many Requests
     */
    protected isClientError(status: ResponseStatus): boolean {
        return this.isStatusInCategory(status, HttpStatusCategory.CLIENT_ERROR);
    }

    /**
     * Check if the response indicates a server error
     * Status code range: 500-599
     * Common codes:
     * - 500: Internal Server Error
     * - 502: Bad Gateway
     * - 503: Service Unavailable
     * - 504: Gateway Timeout
     */
    protected isServerError(status: ResponseStatus): boolean {
        return this.isStatusInCategory(status, HttpStatusCategory.SERVER_ERROR);
    }

    /**
     * Get a descriptive error message for the response status
     */
    protected getErrorMessage(status: ResponseStatus): string {
        if (status.statusCode === HttpStatusCategory.NO_RESPONSE) {
            return 'No response received from server';
        }

        const defaultMessage = `Request failed with status: ${status.statusCode} ${status.statusMessage}`;
        return defaultMessage;
    }

    /**
     * Extract status information from different types of responses
     * Handles both function-style (Puppeteer/Playwright) and property-style (Cheerio/Got) responses
     * @param response - The crawler response object or null
     * @returns Normalized response status with code and message
     */
    protected extractResponseStatus(response: CrawlerResponse | null): ResponseStatus {
        if (!response) {
            return {
                statusCode: HttpStatusCategory.NO_RESPONSE,
                statusMessage: 'No response received'
            };
        }

        let statusCode: number;
        let statusMessage: string;

        try {
            // Handle both function-style and property-style status access
            if (typeof response.status === 'function') {
                // Playwright/Puppeteer style
                statusCode = response.status();
                if (typeof response.statusText === 'function') {
                    statusMessage = response.statusText();
                } else {
                    statusMessage = (response.statusText && typeof response.statusText === 'string')
                        ? response.statusText
                        : `HTTP ${statusCode}`;
                }
            } else {
                // Cheerio/Got style - handle multiple possible property names
                statusCode = response.statusCode ?? response.status ?? HttpStatusCategory.NO_RESPONSE;

                if (response.statusMessage && typeof response.statusMessage === 'string') {
                    statusMessage = response.statusMessage;
                } else if (typeof response.statusText === 'function') {
                    statusMessage = response.statusText();
                } else if (response.statusText && typeof response.statusText === 'string') {
                    statusMessage = response.statusText;
                } else {
                    statusMessage = ``;
                }
            }

            // Validate status code
            if (typeof statusCode !== 'number' || statusCode < 0) {
                statusCode = HttpStatusCategory.NO_RESPONSE;
                statusMessage = 'Invalid status code received';
            }

        } catch (error) {
            // If we can't extract status info, log the error and return default
            log.debug(`Failed to extract response status: ${error}`);
            return {
                statusCode: HttpStatusCategory.NO_RESPONSE,
                statusMessage: 'Failed to extract response status'
            };
        }

        return { statusCode, statusMessage };
    }

    /**
     * Create a structured error object
     */
    protected createCrawlerError(
        type: CrawlerErrorType,
        message: string,
        url: string,
        details?: {
            code?: number;
            stack?: string;
            metadata?: Record<string, any>;
        }
    ): CrawlerError {
        if (process.env.NODE_ENV === 'production') {
            delete details?.stack;
        }
        return {
            type,
            message,
            url,
            ...details
        };
    }

    /**
     * Handle failed requests with proper error reporting
     * Specifically handles HTTP-related failures (status codes, network issues)
     */
    protected async handleFailedRequest(
        context: CrawlingContext,
        status: ResponseStatus,
        data?: any,
        tryExtractData = false
    ): Promise<void> {
        if (tryExtractData) {
            let extractedData = {};
            // try to extract data
            try {
                extractedData = await this.dataExtractor.extractData(context);
                data = {
                    ...data,
                    ...extractedData
                }
            } catch (error) {
            }
        }
        const { jobId, queueName } = context.request.userData;
        let error = null;
        if (status.statusCode === 0) {
            // Use the original error message directly
            let errorMessage = 'Page is not available';
            if (data instanceof Error && data.message) {
                errorMessage = data.message;
            }

            error = this.createCrawlerError(
                CrawlerErrorType.HTTP_ERROR,
                errorMessage,
                context.request.url,
            );
        } else {
            error = this.createCrawlerError(
                CrawlerErrorType.HTTP_ERROR,
                `Page is not available: ${status.statusCode} ${status.statusMessage}`,
                context.request.url,
                {
                    code: status.statusCode,
                    metadata: {
                        ...data,
                        statusCode: status.statusCode,
                        statusMessage: status.statusMessage
                    }
                }
            );
        }

        // For scrape jobs: update DB counters and mark failed
        if (jobId && context.request.userData.type === JOB_TYPE_SCRAPE) {
            try {
                await this.jobManager.markFailed(
                    jobId,
                    queueName,
                    error.message,
                    {
                        ...error,
                        ...error.metadata
                    }
                );
                await failedJob(jobId, error.message, false, { total: 1, completed: 0, failed: 1 });
                await BandwidthManager.getInstance().flushJob(jobId);
            } catch { }
        }

        log.error(`[${queueName}] [${jobId}] ${error.message} (${error.type})`);
    }

    /**
     * Handle errors that occur during data extraction
     * Specifically handles parsing, validation, and extraction process errors
     */
    protected async handleExtractionError(
        context: CrawlingContext,
        originalError: Error
    ): Promise<void> {
        const { jobId, queueName } = context.request.userData;
        const error = this.createCrawlerError(
            CrawlerErrorType.EXTRACTION_ERROR,
            `Data extraction failed: ${originalError.message}`,
            context.request.url,
            {
                stack: originalError.stack
            }
        );


        if (jobId && context.request.userData.type === JOB_TYPE_SCRAPE) {
            try {
                await this.jobManager.markFailed(
                    jobId,
                    queueName,
                    error.message,
                    error
                );
                await failedJob(jobId, error.message, false, { total: 1, completed: 0, failed: 1 });
                await BandwidthManager.getInstance().flushJob(jobId);
            } catch { }
        }

        log.error(`[${queueName}] [${jobId}] ${error.message} (${error.type})`);
        if (error.stack) {
            log.debug(`Error stack: ${error.stack}`);
        }
    }

    /**
     * Handle crawl-specific logic
     */
    protected async handleCrawlLogic(context: CrawlingContext, data: any): Promise<void> {

        const limit = context.request.userData.crawl_options?.limit || 10;
        const maxDepth = context.request.userData.crawl_options?.max_depth || 10;
        const strategy = context.request.userData.crawl_options?.strategy || 'same-domain';
        const includePaths = context.request.userData.crawl_options?.include_paths || [];
        const excludePaths = context.request.userData.crawl_options?.exclude_paths || [];

        try {
            // If already finalized or enqueued reached limit, skip enqueue
            const jobId = context.request.userData.jobId as string | undefined;
            const pm = ProgressManager.getInstance();
            if (jobId) {
                try {
                    const [enq, finalized, cancelled] = await Promise.all([
                        pm.getEnqueued(jobId),
                        pm.isFinalized(jobId),
                        pm.isCancelled(jobId),
                    ]);
                    if (enq >= limit || finalized || cancelled) {
                        log.debug(`[${context.request.userData.queueName}] [${context.request.userData.jobId}] Limit reached/finalized/cancelled (enqueued=${enq}, limit=${limit}), skipping enqueueLinks`);
                        return;
                    }
                } catch { /* ignore */ }
            }
            // Split include_paths into globs and regexps to support both patterns
            const includeGlobs: string[] = [];
            const includeRegexps: RegExp[] = [];
            for (const pattern of includePaths as Array<string>) {
                if (typeof pattern !== 'string') continue;
                // Support regex literal style strings: /pattern/flags
                const match = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
                if (match) {
                    const body: string = match[1] ?? '';
                    const flagsStr: string = match[2] ?? '';
                    try {
                        includeRegexps.push(new RegExp(body, flagsStr));
                        continue;
                    } catch {
                        // Fall through to treat as glob if regex is invalid
                    }
                }
                // Otherwise treat as glob
                includeGlobs.push(pattern);
            }

            // Build exclude list; if any exclude is provided, also exclude the current URL
            const exclude: string[] = [];
            if (Array.isArray(excludePaths) && excludePaths.length > 0) {
                exclude.push(...(excludePaths as string[]));
                exclude.push(context.request.url);
            }
            // enqueueLinks is context-aware and doesn't need explicit requestQueue
            const pmForEnqueue = ProgressManager.getInstance();
            let links: any = { processedRequests: [] };
            const isCrawlJob = context.request.userData.type === JOB_TYPE_CRAWL && jobId;
            if (isCrawlJob) {
                try { await pmForEnqueue.beginEnqueue(jobId); } catch { }
            }
            console.log('includeGlobs', includeGlobs);
            console.log('includeRegexps', includeRegexps);
            try {
                const enqLinks = await context.enqueueLinks({
                    ...(includeGlobs.length > 0 ? { globs: includeGlobs } : {}),
                    ...(includeRegexps.length > 0 ? { regexps: includeRegexps } : {}),
                    ...(exclude.length > 0 ? { exclude } : {}),
                    // Pass along the userData to new requests
                    userData: {
                        ...context.request.userData,
                    },
                    // Use 'all' strategy to crawl more broadly, or 'same-domain' for same domain
                    strategy: strategy,
                    // Keep original limit to ensure we don't under-enqueue
                    limit: limit,
                    onSkippedRequest: ({ url, reason }) => {
                        // log.debug(`[${context.request.userData.queueName}] [${context.request.userData.jobId}] Skipped (${reason}): ${url}`);
                    },
                    transformRequestFunction: (request) => {
                        const jobId = request.userData?.jobId;
                        if (!jobId) return request;

                        // Depth handling: inherit parent's depth and increment
                        const parentDepth = (context.request.userData as any)?.depth ?? 0;
                        const nextDepth = parentDepth + 1;
                        if (typeof maxDepth === 'number' && nextDepth > maxDepth) {
                            // Skip enqueuing beyond max depth
                            return null as any;
                        }
                        // Preserve all userData fields and only update depth
                        // This ensures options (including proxy), crawl_options, etc. are not lost
                        request.userData = {
                            ...request.userData,
                            depth: nextDepth,
                            // Set original_url to the new request's own URL for proxy rule matching
                            // Each link should use its own URL to match proxy rules, not inherit parent's
                            original_url: request.url
                        } as any;

                        // Use Crawlee's own uniqueKey computation to ensure consistency
                        const baseUnique = request.uniqueKey ?? Request.computeUniqueKey({
                            url: request.url,
                            method: (request as any).method ?? 'GET',
                            payload: (request as any).payload,
                            keepUrlFragment: (request as any).keepUrlFragment ?? false,
                            useExtendedUniqueKey: (request as any).useExtendedUniqueKey ?? false,
                        });
                        request.uniqueKey = `${jobId}-${baseUnique}`;
                        return request;
                    },
                });
                links = enqLinks;
            } catch (error) {
                log.error(`Error in enqueueLinks: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                if (isCrawlJob) {
                    try { await pmForEnqueue.endEnqueue(jobId!); } catch { }
                }
            }
            // Increase enqueued count for crawl jobs only (count only truly newly enqueued)
            if (context.request.userData.type === JOB_TYPE_CRAWL) {
                const jobId = context.request.userData.jobId;
                // Count only truly newly enqueued requests (prefer enqueuedRequests if available)
                const added = (links as any).enqueuedRequests?.length ?? (
                    (links as any).processedRequests
                        ? (links as any).processedRequests.filter((r: any) => !r.wasAlreadyPresent && !r.wasAlreadyHandled).length
                        : 0
                );
                await ProgressManager.getInstance().incrementEnqueued(jobId, added);
                // After enqueue completes for this batch, proactively attempt finalize (no-op unless conditions met)
                try {
                    const finalizeTarget = (context.request.userData?.crawl_options?.limit as number) || 0;
                    await ProgressManager.getInstance().tryFinalize(
                        jobId,
                        context.request.userData.queueName,
                        { reason: 'post-enqueue-check' },
                        finalizeTarget
                    );
                } catch { }
            }
            log.info(`[${context.request.userData.queueName}] [${context.request.userData.jobId}] Links enqueued: ${links.processedRequests.length}`);
        } catch (error) {
            log.error(`Error in enqueueLinks: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Check if a URL should be scraped based on scrape_paths configuration
     * @param url - The URL to check
     * @param scrapePaths - Array of glob/regex patterns from scrape_paths config
     * @returns true if the URL should be scraped, false otherwise
     */
    protected shouldScrapeUrl(url: string, scrapePaths?: string[]): boolean {
        // If scrape_paths is not configured, scrape all URLs (backward compatible)
        if (!scrapePaths || scrapePaths.length === 0) {
            return true;
        }

        // Check if URL matches any scrape_paths pattern
        for (const pattern of scrapePaths) {
            if (typeof pattern !== 'string') continue;

            // Support regex literal style strings: /pattern/flags
            const match = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
            if (match) {
                const body: string = match[1] ?? '';
                const flagsStr: string = match[2] ?? '';
                try {
                    const regex = new RegExp(body, flagsStr);
                    if (regex.test(url)) {
                        return true;
                    }
                    continue;
                } catch {
                    // Fall through to treat as glob if regex is invalid
                }
            }

            // Otherwise treat as glob pattern
            try {
                if (minimatch(url, pattern, { dot: true })) {
                    return true;
                }
            } catch {
                // Ignore invalid patterns
            }
        }

        return false;
    }

    /**
     * Store crawl data
     */
    protected async storeCrawlData(crawlJobId: string, url: string, data: any): Promise<void> {
        const keyValueStore = await Utils.getInstance().getKeyValueStore();
        const key = `crawl-data-${crawlJobId}-${Buffer.from(url).toString('base64')}`;

        await keyValueStore.setValue(key, {
            url,
            data,
            crawled_at: new Date().toISOString()
        });
    }

    constructor(options: EngineOptions = {}) {
        // Validate options using ConfigValidator
        ConfigValidator.validate(options);

        // Initialize storage
        Utils.getInstance().setStorageDirectory();

        // Set default options
        this.options = {
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: process.env.ANYCRAWL_REQUEST_HANDLER_TIMEOUT_SECS ? parseInt(process.env.ANYCRAWL_REQUEST_HANDLER_TIMEOUT_SECS) : 600,
            ...options,
        };

        // Set the request queue if provided
        this.queue = options.requestQueue;

        // Initialize template client
        this.initializeTemplateClient().catch(error => {
            console.log('Template client initialization failed:', error);
        });
    }

    /**
     * Initialize template client
     */
    private async initializeTemplateClient(): Promise<void> {
        try {
            // Import TemplateClient from @anycrawl/template-client package
            const { TemplateClient } = await import('@anycrawl/template-client');
            this.templateClient = new TemplateClient();
            console.log('Template client initialized successfully');
        } catch (error) {
            console.log('Failed to initialize template client:', error);
        }
    }
    /**
     * Check if template client is ready for use
     */
    private isTemplateClientReady(): boolean {
        return this.templateClient !== null;
    }

    /**
     * Create common request and failed request handlers
     */
    protected createCommonHandlers(
        customRequestHandler?: (context: CrawlingContext) => Promise<any> | void,
        customFailedRequestHandler?: (context: CrawlingContext, error: Error) => Promise<any> | void
    ) {
        const checkHttpError = async (context: CrawlingContext) => {
            if (context.response) {
                const status = this.extractResponseStatus(context.response as CrawlerResponse);
                return !this.isSuccessfulResponse(status);
            }
            return false;
        }

        const requestHandler = async (context: CrawlingContext) => {
            // Note: Progress checking is now handled by limitFilterHook in preNavigationHooks
            // This eliminates duplicate logic and ensures consistent behavior

            // Log proxy and session information if available
            try {
                const proxyInfo = (context as any).proxyInfo;
                const sessionId = (context as any).session?.id || (context.request as any).sessionId || 'unknown';
                if (proxyInfo?.url) {
                    const jobId = context.request.userData?.jobId || 'unknown';
                    const queueName = context.request.userData?.queueName || 'unknown';
                    log.info(`[PROXY] [${queueName}] [${jobId}] Request URL: ${context.request.url} → Using proxy: ${proxyInfo.url}, session: ${sessionId}`);
                } else if (sessionId !== 'unknown') {
                    const jobId = context.request.userData?.jobId || 'unknown';
                    const queueName = context.request.userData?.queueName || 'unknown';
                    log.debug(`[SESSION] [${queueName}] [${jobId}] Request URL: ${context.request.url} → Using session: ${sessionId}`);
                }
            } catch (error) {
                // Ignore errors when accessing proxyInfo or session
            }

            // Check for 403 error early and try refreshing before other processing
            // This happens before Crawlee's retry mechanism, giving us a chance to recover
            if (context.response && (context as any).page) {
                const status = this.extractResponseStatus(context.response as CrawlerResponse);
                if (status.statusCode === 403) {
                    const page = (context as any).page;
                    const jobId = context.request.userData?.jobId || 'unknown';
                    const queueName = context.request.userData?.queueName || 'unknown';

                    try {
                        // Wait 10 seconds before retrying to avoid overwhelming the server
                        log.info(`[${queueName}] [${jobId}] 403 Forbidden detected, waiting 10 seconds before retry: ${context.request.url}`);
                        await sleep(10000);

                        // Check if page is still open
                        if (!(page.isClosed && page.isClosed())) {
                            log.info(`[${queueName}] [${jobId}] Attempting to refresh page after wait: ${context.request.url}`);

                            // Capture response after reload
                            let refreshResponse: any = null;
                            const responseHandler = (response: any) => {
                                try {
                                    const responseUrl = typeof response.url === 'function' ? response.url() : response.url;
                                    if (responseUrl === context.request.url || responseUrl === page.url()) {
                                        refreshResponse = response;
                                    }
                                } catch {
                                    // Ignore errors in response handler
                                }
                            };

                            page.on('response', responseHandler);

                            try {
                                // Reload the page and wait for network idle
                                await page.reload({ waitUntil: 'networkidle' });

                                // Wait a bit for the page to fully stabilize
                                await sleep(1000);

                                // Remove the response handler
                                page.off('response', responseHandler);

                                // Check the status code from the refresh response
                                if (refreshResponse) {
                                    let newStatusCode = 403;
                                    try {
                                        newStatusCode = typeof refreshResponse.status === 'function'
                                            ? refreshResponse.status()
                                            : (refreshResponse.status || 403);
                                    } catch {
                                        // Fallback: re-check context.response
                                        if (context.response) {
                                            const newStatus = this.extractResponseStatus(context.response as CrawlerResponse);
                                            newStatusCode = newStatus.statusCode;
                                        }
                                    }

                                    if (newStatusCode === 403) {
                                        log.warning(`[${queueName}] [${jobId}] Still 403 after refresh: ${context.request.url}`);
                                    } else {
                                        log.info(`[${queueName}] [${jobId}] Status changed after refresh: ${newStatusCode} for ${context.request.url}`);
                                        // Update context.response if possible
                                        if (refreshResponse && (context as any).response) {
                                            (context as any).response = refreshResponse;
                                        }
                                    }
                                } else {
                                    // If we couldn't capture response, re-check context.response
                                    if (context.response) {
                                        const newStatus = this.extractResponseStatus(context.response as CrawlerResponse);
                                        if (newStatus.statusCode !== 403) {
                                            log.info(`[${queueName}] [${jobId}] Status changed after refresh: ${newStatus.statusCode} for ${context.request.url}`);
                                        }
                                    }
                                }
                            } catch (reloadError) {
                                page.off('response', responseHandler);
                                throw reloadError;
                            }
                        }
                    } catch (refreshError) {
                        log.warning(`[${queueName}] [${jobId}] Failed to refresh page for 403 error: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
                    }
                }
            }

            // check if http status code is 400 or higher
            // Note: 403 refresh logic is already handled earlier in the handler (before this check)
            let isHttpError = await checkHttpError(context);

            // Cheerio traffic tracking (browser engines use CDP-based tracking)
            try {
                const jobId = context.request.userData?.jobId as string | undefined;
                const isBrowser = !!(context as any).page;
                if (jobId && !isBrowser && context.response) {
                    const headers: Record<string, any> = (context.response as any).headers || {};
                    const rawContentLength = headers["content-length"] ?? headers["Content-Length"];
                    let responseBytes = 0;
                    if (rawContentLength !== undefined) {
                        const parsed = Number.parseInt(String(rawContentLength), 10);
                        if (Number.isFinite(parsed) && parsed > 0) responseBytes = parsed;
                    }
                    if (responseBytes === 0) {
                        const body: any = (context as any).body;
                        if (Buffer.isBuffer(body)) responseBytes = body.length;
                        else if (typeof body === "string") responseBytes = Buffer.byteLength(body, "utf8");
                    }

                    let requestBytes = 0;
                    try {
                        const reqHeaders = (context.request as any).headers ?? {};
                        requestBytes = Buffer.byteLength(JSON.stringify(reqHeaders), "utf8");
                    } catch { }

                    const metric: RequestTrafficMetric = {
                        id: `cheerio:${String((context.request as any).id ?? context.request.uniqueKey ?? Date.now())}`,
                        jobId,
                        engine: "cheerio",
                        url: context.request.url,
                        method: String((context.request as any).method ?? "GET"),
                        requestBytes,
                        responseBytes,
                        totalBytes: requestBytes + responseBytes,
                        startTime: Date.now(),
                        endTime: Date.now(),
                        failed: isHttpError,
                    };

                    BandwidthManager.getInstance().recordRequest(metric);
                }
            } catch { }

            let data = null;

            // Create a Promise wrapper to control page lifecycle for template execution
            // Based on: https://github.com/apify/crawlee/discussions/2242
            // The page will NOT be closed until this promise resolves
            let templateExecutionResolver!: () => void;
            const templateExecutionPromise = new Promise<void>((resolve) => {
                templateExecutionResolver = resolve;
            });

            try {
                // First, handle wait_for_selector if provided (browser-only)
                const waitForSelector = context.request.userData.options?.wait_for_selector;
                if (waitForSelector !== undefined) {
                    try {
                        log.info(`[wait_for_selector] received value type=${typeof waitForSelector} raw=${(() => { try { return JSON.stringify(waitForSelector); } catch { return String(waitForSelector); } })()}`);
                    } catch { /* ignore */ }
                }
                if (waitForSelector) {
                    if ((context as any).page) {
                        const page: any = (context as any).page;
                        const engineName = this.constructor.name.toLowerCase();

                        const entries = Array.isArray(waitForSelector) ? waitForSelector : [waitForSelector];
                        for (const entry of entries) {
                            let selector: string | undefined;
                            let timeout: number | undefined;
                            let state: any | undefined;
                            if (typeof entry === 'string') {
                                selector = entry;
                                state = 'visible';
                            } else if (entry && typeof entry === 'object' && (entry as any).selector) {
                                selector = (entry as any).selector;
                                timeout = (entry as any).timeout;
                                state = (entry as any).state ?? 'visible';
                            }
                            if (!selector) continue;

                            log.debug(`Waiting for selector '${selector}' (state=${state}${timeout ? `, timeout=${timeout}ms` : ''}) at ${context.request.url}`);
                            if (typeof page.waitForSelector !== 'function') continue;
                            try {
                                if (engineName.includes('playwright')) {
                                    await page.waitForSelector(selector, { state, timeout });
                                } else if (engineName.includes('puppeteer')) {
                                    const opts: any = { timeout };
                                    if (state === 'visible') opts.visible = true;
                                    if (state === 'hidden' || state === 'detached') opts.hidden = true;
                                    await page.waitForSelector(selector, opts);
                                } else {
                                    await page.waitForSelector(selector, { timeout });
                                }
                            } catch (err) {
                                log.warning(`[wait_for_selector] Failed for selector '${selector}' at ${context.request.url}: ${err instanceof Error ? err.message : String(err)}`);
                            }
                        }
                    } else {
                        log.warning(`'wait_for_selector' is ignored for non-browser crawlers. URL: ${context.request.url}`);
                    }
                }


                // Then handle wait_for delay (browser-only)
                if (context.request.userData.options?.wait_for) {
                    if (context.page) {
                        log.debug(`Waiting for ${context.request.userData.options.wait_for} ms for ${context.request.url}`);
                        await sleep(context.request.userData.options.wait_for);
                    } else {
                        log.warning(`'wait_for' option is not supported for non-browser crawlers. URL: ${context.request.url}`);
                    }
                }

                // Expose lazy pre-navigation capture access via context
                try {
                    const jobId = context.request.userData?.jobId;
                    const templateId = context.request.userData?.options?.template_id;
                    if (jobId && templateId) {
                        // Multiple capture groups; expose a function to fetch by capture key
                        (context as any).getPreNavCaptured = async (captureKey: string) => {
                            try {
                                if (typeof captureKey !== 'string' || !captureKey) return [];
                                const redisKey = `preNav:${jobId}:${captureKey}`;
                                const redis = Utils.getInstance().getRedisConnection();
                                const items = await redis.lrange(redisKey, 0, -1);
                                if (!Array.isArray(items)) return [];
                                return items.map((s) => { try { return JSON.parse(s); } catch { return s; } });
                            } catch { return []; }
                        };
                        (context as any).preNavKeyPrefix = `preNav:${jobId}:`;
                    }
                } catch { /* ignore */ }

                // Check if this is a template-based request BEFORE extraction
                const templateId = context.request.userData.options?.template_id;
                const hasTemplate = templateId && this.isTemplateClientReady();

                if (hasTemplate) {
                    // Execute template and extraction CONCURRENTLY
                    // This ensures page stays alive during BOTH operations
                    log.info(`[${context.request.userData.queueName}] [${context.request.userData.jobId}] Starting concurrent extraction and template execution`);

                    try {
                        const templateVariables = context.request.userData.templateVariables || {};

                        // Lightweight heartbeat to keep Playwright page active during long-running template/debug
                        const page = (context as any).page;
                        let keepAlive = true;
                        const keepAlivePromise = (async () => {
                            if (!page) return;
                            while (keepAlive) {
                                try {
                                    // tiny no-op using a safe method that does not execute JS in the page
                                    if (!page.isClosed || !page.isClosed()) {
                                        // url() is lightweight and safe to call; it keeps the connection active
                                        await page.url();
                                    } else {
                                        break;
                                    }
                                } catch {
                                    // ignore transient evaluation errors
                                }
                                await sleep(1000);
                            }
                        })();

                        // Start both operations in parallel
                        const [extractionData, templateResult] = await Promise.all([
                            // Extraction promise
                            this.dataExtractor.extractData(context),

                            // Template execution promise
                            (async () => {
                                const templateExecutionContext = {
                                    templateId,
                                    request: {
                                        url: context.request.url,
                                        method: context.request.method || 'GET',
                                        headers: context.request.headers || {},
                                        body: (context.request as any).body,
                                        uniqueKey: context.request.uniqueKey,
                                    },
                                    userData: context.request.userData,
                                    variables: templateVariables,
                                    metadata: {
                                        engine: this.constructor.name.toLowerCase().replace('engine', ''),
                                        timestamp: new Date().toISOString(),
                                        // Propagate per-request timeout to template sandbox if provided
                                        timeout: context.request.userData?.options?.timeout
                                    },
                                    response: context.response,
                                    scrapeResult: {}, // Template starts without scrapeResult, but has page access
                                    // Pass page object for browser-based engines (Playwright/Puppeteer)
                                    page: (context as any).page,
                                    // Host-side preNav API (Redis-backed) for sandbox to call
                                    preNavHost: {
                                        wait: async (key: string, opts?: { timeoutMs?: number }) => {
                                            const redis = Utils.getInstance().getRedisConnection();
                                            const jobId = context.request.userData?.jobId || 'unknown';
                                            const requestId = context.request.uniqueKey || 'unknown';
                                            const ns = `${jobId}:${requestId}:${key}`;
                                            const dataKey = `prenav:data:${ns}`;
                                            const sigKey = `prenav:sig:${ns}`;
                                            log.debug(`[preNavHost.wait] jobId=${jobId}, requestId=${requestId}, key=${key}, dataKey=${dataKey}`);
                                            // Fast path
                                            const s = await redis.get(dataKey);
                                            if (s) {
                                                log.debug(`[preNavHost.wait] fast path hit for key=${key}, data length=${s.length}`);
                                                try { return JSON.parse(s); } catch { return s; }
                                            }
                                            // Wait on signal
                                            log.debug(`[preNavHost.wait] waiting on signal for key=${key}, sigKey=${sigKey}`);
                                            const timeoutMs = opts?.timeoutMs ?? 30000;
                                            const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
                                            try { await redis.blpop(sigKey, timeoutSec); } catch { /* ignore */ }
                                            const after = await redis.get(dataKey);
                                            if (after) {
                                                log.debug(`[preNavHost.wait] data retrieved after wait for key=${key}, data length=${after.length}`);
                                                try { return JSON.parse(after); } catch { return after; }
                                            }
                                            // Timeout - return undefined instead of throwing error
                                            log.warning(`[preNavHost.wait] timeout for key=${key} (waited ${timeoutMs}ms) - returning undefined`);
                                            return undefined;
                                        },
                                        get: async (key: string) => {
                                            const redis = Utils.getInstance().getRedisConnection();
                                            const jobId = context.request.userData?.jobId || 'unknown';
                                            const requestId = context.request.uniqueKey || 'unknown';
                                            const ns = `${jobId}:${requestId}:${key}`;
                                            const dataKey = `prenav:data:${ns}`;
                                            log.debug(`[preNavHost.get] jobId=${jobId}, requestId=${requestId}, key=${key}, dataKey=${dataKey}`);
                                            const s = await redis.get(dataKey);
                                            if (!s) {
                                                log.debug(`[preNavHost.get] no data found for key=${key}`);
                                                return undefined;
                                            }
                                            log.debug(`[preNavHost.get] data found for key=${key}, data length=${s.length}`);
                                            try { return JSON.parse(s); } catch { return s; }
                                        },
                                        has: async (key: string) => {
                                            const redis = Utils.getInstance().getRedisConnection();
                                            const jobId = context.request.userData?.jobId || 'unknown';
                                            const requestId = context.request.uniqueKey || 'unknown';
                                            const ns = `${jobId}:${requestId}:${key}`;
                                            const dataKey = `prenav:data:${ns}`;
                                            log.debug(`[preNavHost.has] jobId=${jobId}, requestId=${requestId}, key=${key}, dataKey=${dataKey}`);
                                            const exists = await redis.exists(dataKey);
                                            log.debug(`[preNavHost.has] key=${key}, exists=${exists}`);
                                            return !!exists;
                                        }
                                    }
                                };

                                log.debug(`[templateExecutionContext] created with keys: ${Object.keys(templateExecutionContext).join(',')}, preNavHost exists: ${!!templateExecutionContext.preNavHost}`);

                                log.info(`[${context.request.userData.queueName}] [${context.request.userData.jobId}] Template execution started: ${templateId}`);
                                const result = await this.templateClient!.executeTemplate(templateId as string, templateExecutionContext);
                                log.info(`[${context.request.userData.queueName}] [${context.request.userData.jobId}] Template execution completed: ${templateId}`);
                                return result;
                            })()
                        ]);

                        // Merge results
                        data = extractionData;
                        if (templateResult.success && templateResult.data.result) {
                            data = {
                                ...data,
                                ...templateResult.data.result
                            }
                        }

                        log.info(`[${context.request.userData.queueName}] [${context.request.userData.jobId}] Concurrent execution completed successfully`);
                    } finally {
                        // stop heartbeat and wait for it to exit
                        try {
                            // keepAlive is defined in try scope; set false to exit loop
                            (async () => { /* scope guard */ })();
                        } catch { }
                        try {
                            // @ts-ignore - keepAlive is in scope of this finally
                            keepAlive = false;
                        } catch { }
                        try {
                            // @ts-ignore - keepAlivePromise is in scope of this finally
                            await keepAlivePromise;
                        } catch { }
                    }
                    templateExecutionResolver?.();
                } else {
                    // No template, just run extraction
                    data = await this.dataExtractor.extractData(context);

                    // Resolve immediately since no template
                    templateExecutionResolver?.();
                }

                // Run custom handler if provided
                if (customRequestHandler) {
                    await customRequestHandler(context);
                    return;
                }

                // Check if we should scrape this URL (for crawl jobs only)
                // For scrape jobs, always save the result
                const shouldScrape = context.request.userData.type === JOB_TYPE_SCRAPE
                    || this.shouldScrapeUrl(
                        context.request.url,
                        context.request.userData.crawl_options?.scrape_paths
                    );

                // insert job result - use parentId if available (for search scrape), otherwise use jobId
                const resultJobId = context.request.userData.parentId || context.request.userData.jobId;

                // Only save result if shouldScrape is true
                if (shouldScrape) {
                    await insertJobResult(resultJobId, context.request.url, data, JOB_RESULT_STATUS.SUCCESS);
                } else {
                    log.info(`[${context.request.userData.queueName}] [${context.request.userData.jobId}] Skipping scrape for ${context.request.url} (not in scrape_paths)`);
                }

                // Handle crawl logic if this is a crawl job (always run to discover links)
                if (context.request.userData.type === JOB_TYPE_CRAWL) {
                    await this.handleCrawlLogic(context, data);
                }

                // add jobId to data
                data.jobId = context.request.userData.jobId;

                // add proxy to data (base, stealth, or custom)
                const proxyValue = context.request.userData?.options?.proxy;
                data.proxy = getResolvedProxyModeName(proxyValue);

            } catch (error) {
                console.log('Error in requestHandler:', error);

                // Ensure template execution promise is resolved even on error
                templateExecutionResolver?.();

                // Handle extraction-specific errors here; rethrow others to failedRequestHandler
                if (error instanceof ExtractionError) {
                    await this.handleExtractionError(
                        context,
                        error as Error
                    );
                    // For crawl jobs: mark page done as failed and attempt finalize
                    try {
                        const { queueName, jobId } = context.request.userData;
                        if (jobId && context.request.userData.type === JOB_TYPE_CRAWL) {
                            if (!(context.request.userData as any)._doneAccounted) {
                                (context.request.userData as any)._doneAccounted = true;
                                await ProgressManager.getInstance().markPageDone(jobId, false);
                                const finalizeTarget = (context.request.userData?.crawl_options?.limit as number) || 0;
                                await ProgressManager.getInstance().tryFinalize(
                                    jobId,
                                    queueName,
                                    { reason: 'extract-error' },
                                    finalizeTarget
                                );
                            }
                        }
                    } catch { }
                    return;
                }
                throw error;
            }
            const { queueName, jobId } = context.request.userData;

            // Log success
            log.info(`[${queueName}] [${jobId}] Pushing data for ${context.request.url}`);
            // store into job table

            // Update job status if jobId exists
            if (jobId) {
                if (isHttpError) {
                    const status = this.extractResponseStatus(context.response as CrawlerResponse);
                    await this.handleFailedRequest(context, status, data);
                } else if (context.request.userData.type === JOB_TYPE_SCRAPE) {
                    // Update counters + completed in one call
                    try {
                        await this.jobManager.markCompleted(jobId, queueName, data);
                        await completedJob(jobId, true, { total: 1, completed: 1, failed: 0 });
                        await BandwidthManager.getInstance().flushJob(jobId);
                    } catch { }
                }
                // For crawl jobs: mark page done and try finalize
                if (context.request.userData.type === JOB_TYPE_CRAWL) {
                    const wasSuccess = !isHttpError;
                    // Ensure we only count once per request
                    if (!(context.request.userData as any)._doneAccounted) {
                        (context.request.userData as any)._doneAccounted = true;
                        const { done, enqueued } = await ProgressManager.getInstance().markPageDone(jobId, wasSuccess);
                        // Always attempt finalize; it will no-op until conditions are met
                        const finalizeTarget = (context.request.userData?.crawl_options?.limit as number) || 0;
                        const finalizeResult = await ProgressManager.getInstance().tryFinalize(jobId, queueName, { reason: 'post-done-check' }, finalizeTarget);
                        if (finalizeResult) {
                            log.info(`[${queueName}] [${jobId}] Job finalized successfully after processing page ${done}`);
                        }
                    }
                }
            }
        };

        const failedRequestHandler = async (context: CrawlingContext, error: Error) => {
            // Handle CrawlLimitReachedError specially - this is expected behavior, not a failure
            if (error instanceof CrawlLimitReachedError) {
                const { queueName, jobId } = context.request.userData;
                log.info(`[EXPECTED] [${queueName}] [${jobId}] Crawl limit reached: ${error.reason} - attempting to finalize job`);

                // Try to finalize the job when limit is reached
                if (jobId && queueName && error.reason === 'limit reached') {
                    try {
                        const finalizeTarget = (context.request.userData?.crawl_options?.limit as number) || 0;
                        const finalizeResult = await ProgressManager.getInstance().tryFinalize(jobId, queueName, {}, finalizeTarget);
                        if (finalizeResult) {
                            log.info(`[${queueName}] [${jobId}] Job finalized successfully after limit reached in failedRequestHandler`);
                        } else {
                            log.warning(`[${queueName}] [${jobId}] Job finalization failed in failedRequestHandler - may need manual intervention`);
                        }
                    } catch (finalizeError) {
                        log.warning(`[${queueName}] [${jobId}] Failed to finalize job in failedRequestHandler: ${finalizeError}`);
                    }
                }

                return; // Skip processing this error
            }

            // Note: Progress checking is now handled by limitFilterHook in preNavigationHooks
            // This eliminates duplicate logic and ensures consistent behavior

            // Check if this is a template-based request and handle template failure
            const templateId = context.request.userData.templateId;
            if (templateId && this.templateClient?.isInitialized()) {
                try {
                    log.debug(`Handling template failure for ${templateId}: ${error.message}`);
                    const templateVariables = context.request.userData.templateVariables || {};
                    const templateFailureResult = await this.templateClient.executeFailureHandler(
                        context,
                        templateId,
                        error,
                        templateVariables
                    );

                    // If template failure handler returns data, use it
                    if (templateFailureResult.data) {
                        log.info(`Template failure handler processed error for ${templateId}`);
                        return;
                    }
                } catch (templateError) {
                    log.error(`Template failure handler failed for ${templateId}: ${templateError instanceof Error ? templateError.message : String(templateError)}`);
                    // Continue with default failure handling
                }
            }

            // Run custom handler if provided
            if (customFailedRequestHandler) {
                await customFailedRequestHandler(context, error);
                return;
            }

            const status = this.extractResponseStatus(context.response as CrawlerResponse);

            await this.handleFailedRequest(context, status, error, true);
            // For crawl jobs: also mark page done on hard failure
            const { queueName, jobId } = context.request.userData;
            if (jobId && context.request.userData.type === JOB_TYPE_CRAWL) {
                if (!(context.request.userData as any)._doneAccounted) {
                    (context.request.userData as any)._doneAccounted = true;
                    const { done, enqueued } = await ProgressManager.getInstance().markPageDone(jobId, false);
                    const finalizeTarget = (context.request.userData?.crawl_options?.limit as number) || 0;
                    const finalizeResult = await ProgressManager.getInstance().tryFinalize(jobId, queueName, { reason: 'failed-page-check' }, finalizeTarget);
                    if (finalizeResult) {
                        log.info(`[${queueName}] [${jobId}] Job finalized successfully after failed page processing`);
                    }
                }
            }
        };

        return { requestHandler, failedRequestHandler };
    }

    /**
     * Apply engine-specific configurations using EngineConfigurator
     */
    protected applyEngineConfigurations(crawlerOptions: any, engineType: ConfigurableEngineType): any {
        return EngineConfigurator.configure(crawlerOptions, engineType);
    }

    /**
     * Run the crawler
     */
    async run(): Promise<void> {
        if (!this.isInitialized) {
            await this.init();
        }

        if (!this.engine) {
            throw new Error("Engine not initialized");
        }

        const queueName = this.options.requestQueueName || 'default';

        try {
            log.info(`[${queueName}] Starting crawler engine`);
            await this.engine.run();
            log.info(`[${queueName}] Crawler engine started successfully`);
        } catch (error) {
            log.error(`[${queueName}] Error running crawler: ${error}`);
            throw error;
        }
    }

    /**
     * Stop the crawler
     */
    async stop(): Promise<void> {
        if (this.engine) {
            await this.engine.stop();
        }
    }

    /**
     * Check if the engine is initialized
     */
    isEngineInitialized(): boolean {
        return this.isInitialized;
    }

    /**
     * Get the underlying crawler engine instance
     */
    public getEngine(): any {
        if (!this.engine) {
            throw new Error("Engine not initialized. Call init() first.");
        }
        return this.engine;
    }

    /**
     * Abstract method for engine initialization
     */
    abstract init(): Promise<void>;
}
