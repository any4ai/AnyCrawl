import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import { Logger } from './logger.js';
const log = new Logger();
import {
    ApiResponse,
    CrawlJobResponse,
    CrawlStatusResponse,
    CrawlResultsResponse,
    ScrapeResult,
    SearchResult,
    ScrapeRequest,
    CrawlRequest,
    SearchRequest,
    CrawlAndWaitResult,
    MapRequest,
    MapResult,
} from './types.js';
import { scrape as scrapeMethod } from './methods/scrape.js';
import { createCrawl as createCrawlMethod } from './methods/crawl.js';
import { search as searchMethod } from './methods/search.js';
import { map as mapMethod } from './methods/map.js';

/**
 * AnyCrawl JavaScript/TypeScript client.
 *
 * Provides thin wrappers around the HTTP API for scraping, crawling,
 * job management, and search. Errors are normalized to throw standard
 * Error instances with readable messages.
 */
export class AnyCrawlClient {
    private client: AxiosInstance;
    private apiKey: string;
    private baseUrl: string;
    private onAuthFailure?: () => void;

    /**
     * Create a new AnyCrawl client.
     *
     * @param apiKey API key for authorization
     * @param baseUrl Optional base URL for the API (defaults to https://api.anycrawl.dev)
     * @param onAuthFailure Optional callback invoked on 401/403 responses
     */
    constructor(apiKey: string, baseUrl: string = 'https://api.anycrawl.dev', onAuthFailure?: () => void) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        if (onAuthFailure !== undefined) this.onAuthFailure = onAuthFailure;

        this.client = axios.create({
            baseURL: this.baseUrl,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 300000,
        });

        this.client.interceptors.response.use(
            (response: AxiosResponse) => response,
            (error: AxiosError) => this.normalizeAxiosError(error)
        );
    }

    /**
     * Set a callback that is invoked whenever an authentication/authorization
     * error is detected (HTTP 401/403). Useful for triggering re-auth flows.
     *
     * @param callback Function to call on auth failure
     */
    setAuthFailureCallback(callback: () => void): void {
        this.onAuthFailure = callback;
    }

    private isAuthenticationError(status: number, _errorMessage: string): boolean {
        // API emits 401 for auth failures; 403 reserved for future use
        return status === 401 || status === 403;
    }

    /** Normalize Axios errors to consistent Error instances. */
    private normalizeAxiosError(error: AxiosError | any): never {
        const maybeStatus = (error?.response as any)?.status;
        const maybeData = (error?.response as any)?.data;
        if (maybeStatus !== undefined) {
            const errorMessage = maybeData?.error || maybeData?.message || 'Unknown error';
            if (this.isAuthenticationError(Number(maybeStatus), errorMessage)) {
                log.warn('Authentication error detected');
                if (this.onAuthFailure) this.onAuthFailure();
                throw new Error(`Authentication failed: ${errorMessage}`);
            }
            if (Number(maybeStatus) === 402 && typeof maybeData?.current_credits === 'number') {
                throw new Error(`Payment required: ${errorMessage}. current_credits=${maybeData.current_credits}`);
            }
            throw new Error(`API Error ${maybeStatus}: ${errorMessage}`);
        }
        if (error && error.request) {
            throw new Error('Network error: Unable to reach AnyCrawl API');
        }
        if (error instanceof Error) {
            throw new Error(`Request error: ${error.message}`);
        }
        throw new Error('Unknown request error');
    }

    /**
     * Check API health.
     * @returns A small object like { status: 'ok' }
     */
    async healthCheck(): Promise<{ status: string }> {
        try {
            const response: AxiosResponse<{ status: string }> = await this.client.get('/health');
            return response.data;
        } catch (error: any) {
            return this.normalizeAxiosError(error);
        }
    }

    /**
     * Scrape a single URL using the specified engine and options.
     *
     * @param input Scrape request parameters (url, engine, formats, etc.)
     * @returns A successful or failed scrape result
     */
    async scrape(input: ScrapeRequest): Promise<ScrapeResult> {
        try {
            return await scrapeMethod(this.client, input);
        } catch (error: any) {
            return this.normalizeAxiosError(error);
        }
    }

    /**
     * Create a new crawl job.
     *
     * @param input Crawl request parameters (seed url, engine, strategy, etc.)
     * @returns Crawl job metadata (job_id, status, message)
     */
    async createCrawl(input: CrawlRequest): Promise<CrawlJobResponse> {
        try {
            return await createCrawlMethod(this.client, input);
        } catch (error: any) {
            return this.normalizeAxiosError(error);
        }
    }

    /**
     * Get the current status of a crawl job.
     *
     * @param jobId Crawl job ID
     * @returns Status information (pending/completed/failed/cancelled, progress, credits)
     */
    async getCrawlStatus(jobId: string): Promise<CrawlStatusResponse> {
        try {
            const response: AxiosResponse<any> = await this.client.get(`/v1/crawl/${jobId}/status`);
            const payload: any = response.data;
            if (!payload.success) throw new Error(payload.error || 'Failed to get crawl status');
            return payload.data as CrawlStatusResponse;
        } catch (error: any) {
            return this.normalizeAxiosError(error);
        }
    }

    /**
     * Get a page of crawl results.
     *
     * @param jobId Crawl job ID
     * @param skip Offset for pagination (defaults to 0)
     * @returns A page of results with optional next token info
     */
    async getCrawlResults(jobId: string, skip: number = 0): Promise<CrawlResultsResponse> {
        try {
            const response: AxiosResponse<CrawlResultsResponse> = await this.client.get(`/v1/crawl/${jobId}?skip=${skip}`);
            return response.data;
        } catch (error: any) {
            return this.normalizeAxiosError(error);
        }
    }

    /**
     * Cancel a running crawl.
     *
     * @param jobId Crawl job ID
     * @returns Confirmation object with job_id and status
     */
    async cancelCrawl(jobId: string): Promise<{ job_id: string; status: string }> {
        try {
            const response: AxiosResponse<ApiResponse<{ job_id: string; status: string }>> = await this.client.delete(`/v1/crawl/${jobId}`);
            if (!response.data.success) {
                throw new Error((response.data as any).error || 'Failed to cancel crawl');
            }
            return (response.data as any).data;
        } catch (error: any) {
            return this.normalizeAxiosError(error);
        }
    }

    /**
     * Search the web and optionally scrape each result.
     *
     * @param input Search parameters (query, pagination, locale, scrape options)
     * @returns A list of search results (optionally enriched with scrape fields)
     */
    async search(input: SearchRequest): Promise<SearchResult[]> {
        try {
            return await searchMethod(this.client, input);
        } catch (error: any) {
            return this.normalizeAxiosError(error);
        }
    }

    /**
     * Map a website to discover all URLs.
     *
     * @param input Map parameters (url, limit, include_subdomains, ignore_sitemap)
     * @returns Map result with list of discovered URLs
     */
    async map(input: MapRequest): Promise<MapResult> {
        try {
            return await mapMethod(this.client, input);
        } catch (error: any) {
            return this.normalizeAxiosError(error);
        }
    }

    /** Delay helper used by polling logic. */
    private async sleep(seconds: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
    }

    /**
     * Start a crawl and wait until it reaches a terminal state, then fetch all results.
     *
     * @param input Crawl request options
     * @param pollIntervalSeconds Polling interval in seconds (default: 2)
     * @param timeoutMs Optional timeout in milliseconds
     * @returns Aggregated crawl results and metadata
     */
    /**
     * Create a crawl and block until it finishes, then return all aggregated results.
     *
     * Throws if the job fails or is cancelled, or if a timeout is reached.
     *
     * @param input Crawl request parameters
     * @param pollIntervalSeconds Poll interval in seconds (default: 2s)
     * @param timeoutMs Optional timeout in milliseconds (no timeout if undefined)
     * @returns Aggregated crawl results and metadata
     */
    async crawl(
        input: CrawlRequest,
        pollIntervalSeconds: number = 2,
        timeoutMs?: number
    ): Promise<CrawlAndWaitResult> {
        const started = await this.createCrawl(input);
        const jobId = started.job_id;

        const startedAt = Date.now();
        // Poll for completion
        // Terminal states: completed, failed, cancelled
        // Throw on failed/cancelled, unless caller wants to handle differently
        // Optional timeout
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const status = await this.getCrawlStatus(jobId);
            if (status.status === 'completed') break;
            if (status.status === 'failed') {
                throw new Error(`Crawl failed (job_id=${jobId})`);
            }
            if (status.status === 'cancelled') {
                // throw new Error(`Crawl cancelled (job_id=${jobId})`);
                break;
            }

            if (timeoutMs !== undefined && Date.now() - startedAt > timeoutMs) {
                throw new Error(`Crawl timed out after ${timeoutMs}ms (job_id=${jobId})`);
            }

            await this.sleep(pollIntervalSeconds);
        }

        // Fetch and aggregate all results using pagination via skip
        const aggregated: any[] = [];
        let skip = 0;
        let total = 0;
        let completed = 0;
        let creditsUsed = 0;
        while (true) {
            const page = await this.getCrawlResults(jobId, skip);
            // Some backends may omit totals on subsequent pages; update when present
            if (typeof page.total === 'number') total = page.total;
            if (typeof page.completed === 'number') completed = page.completed;
            if (typeof page.creditsUsed === 'number') creditsUsed = page.creditsUsed;

            if (Array.isArray(page.data) && page.data.length > 0) {
                aggregated.push(...page.data);
            }

            if (page.next) {
                // Advance by number of results fetched so far
                skip = aggregated.length;
            } else {
                break;
            }
        }

        const result: CrawlAndWaitResult = {
            job_id: jobId,
            status: 'completed',
            total,
            completed,
            creditsUsed,
            data: aggregated,
        };
        return result;
    }
}

export * from './types.js';


