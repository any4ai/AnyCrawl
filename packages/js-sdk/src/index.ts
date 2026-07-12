import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import { Logger } from './logger.js';
const log = new Logger();
import {
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
    CreateScheduledTaskRequest,
    UpdateScheduledTaskRequest,
    ScheduledTask,
    ScheduledTaskCreateResponse,
    ScheduledTaskExecutionsResponse,
    CreateWebhookRequest,
    UpdateWebhookRequest,
    Webhook,
    WebhookCreateResponse,
    WebhookDeliveriesResponse,
    WebhookEventsResponse,
    CreateMonitorRequest,
    UpdateMonitorRequest,
    Monitor,
    MonitorCreateResponse,
    MonitorSnapshot,
    MonitorChange,
} from './types.js';
import { scrape as scrapeMethod } from './methods/scrape.js';
import { unwrapApiResponse } from './utils/index.js';
import {
    createCrawl as createCrawlMethod,
    getCrawlStatus as getCrawlStatusMethod,
    getCrawlResults as getCrawlResultsMethod,
    crawlAndWait as crawlAndWaitMethod,
} from './methods/crawl.js';
import { search as searchMethod } from './methods/search.js';
import { map as mapMethod } from './methods/map.js';
import * as scheduledTasksMethods from './methods/scheduled-tasks.js';
import * as webhooksMethods from './methods/webhooks.js';
import * as monitorsMethods from './methods/monitors.js';

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
        const response: AxiosResponse<{ status: string }> = await this.client.get('/health');
        return response.data;
    }

    /**
     * Scrape a single URL using the specified engine and options.
     *
     * @param input Scrape request parameters (url, engine, formats, etc.)
     * @returns A successful or failed scrape result
     */
    async scrape(input: ScrapeRequest): Promise<ScrapeResult> {
        return await scrapeMethod(this.client, input);
    }

    /**
     * Create a new crawl job.
     *
     * @param input Crawl request parameters (seed url, engine, strategy, etc.)
     * @returns Crawl job metadata (job_id, status, message)
     */
    async createCrawl(input: CrawlRequest): Promise<CrawlJobResponse> {
        return await createCrawlMethod(this.client, input);
    }

    /**
     * Get the current status of a crawl job.
     *
     * @param jobId Crawl job ID
     * @returns Status information (pending/completed/failed/cancelled, progress, credits)
     */
    async getCrawlStatus(jobId: string): Promise<CrawlStatusResponse> {
        return await getCrawlStatusMethod(this.client, jobId);
    }

    /**
     * Get a page of crawl results.
     *
     * @param jobId Crawl job ID
     * @param skip Offset for pagination (defaults to 0)
     * @returns A page of results with optional next token info
     */
    async getCrawlResults(jobId: string, skip: number = 0): Promise<CrawlResultsResponse> {
        return await getCrawlResultsMethod(this.client, jobId, skip);
    }

    /**
     * Cancel a running crawl.
     *
     * @param jobId Crawl job ID
     * @returns Confirmation object with job_id and status
     */
    async cancelCrawl(jobId: string): Promise<{ job_id: string; status: string }> {
        const response: AxiosResponse<unknown> = await this.client.delete(`/v1/crawl/${jobId}`);
        return unwrapApiResponse<{ job_id: string; status: string }>(response.data, 'Failed to cancel crawl');
    }

    /**
     * Search the web and optionally scrape each result.
     *
     * @param input Search parameters (query, pagination, locale, scrape options)
     * @returns A list of search results (optionally enriched with scrape fields)
     */
    async search(input: SearchRequest): Promise<SearchResult[]> {
        return await searchMethod(this.client, input);
    }

    /**
     * Map a website to discover all URLs.
     *
     * @param input Map parameters (url, limit, include_subdomains, ignore_sitemap)
     * @returns Map result with list of discovered URLs
     */
    async map(input: MapRequest): Promise<MapResult> {
        return await mapMethod(this.client, input);
    }

    // Scheduled Tasks
    async createScheduledTask(input: CreateScheduledTaskRequest): Promise<ScheduledTaskCreateResponse> {
        return await scheduledTasksMethods.createScheduledTask(this.client, input);
    }

    async listScheduledTasks(): Promise<ScheduledTask[]> {
        return await scheduledTasksMethods.listScheduledTasks(this.client);
    }

    async getScheduledTask(taskId: string): Promise<ScheduledTask> {
        return await scheduledTasksMethods.getScheduledTask(this.client, taskId);
    }

    async updateScheduledTask(taskId: string, input: UpdateScheduledTaskRequest): Promise<ScheduledTask> {
        return await scheduledTasksMethods.updateScheduledTask(this.client, taskId, input);
    }

    async pauseScheduledTask(taskId: string, reason?: string): Promise<void> {
        return await scheduledTasksMethods.pauseScheduledTask(this.client, taskId, reason);
    }

    async resumeScheduledTask(taskId: string): Promise<void> {
        return await scheduledTasksMethods.resumeScheduledTask(this.client, taskId);
    }

    async deleteScheduledTask(taskId: string): Promise<void> {
        return await scheduledTasksMethods.deleteScheduledTask(this.client, taskId);
    }

    async getScheduledTaskExecutions(
        taskId: string,
        params?: { limit?: number; offset?: number }
    ): Promise<ScheduledTaskExecutionsResponse> {
        return await scheduledTasksMethods.getScheduledTaskExecutions(this.client, taskId, params);
    }

    async cancelScheduledTaskExecution(taskId: string, executionId: string): Promise<void> {
        return await scheduledTasksMethods.cancelScheduledTaskExecution(this.client, taskId, executionId);
    }

    // Webhooks
    async createWebhook(input: CreateWebhookRequest): Promise<WebhookCreateResponse> {
        return await webhooksMethods.createWebhook(this.client, input);
    }

    async listWebhooks(): Promise<Webhook[]> {
        return await webhooksMethods.listWebhooks(this.client);
    }

    async getWebhook(webhookId: string): Promise<Webhook> {
        return await webhooksMethods.getWebhook(this.client, webhookId);
    }

    async updateWebhook(webhookId: string, input: UpdateWebhookRequest): Promise<void> {
        return await webhooksMethods.updateWebhook(this.client, webhookId, input);
    }

    async deleteWebhook(webhookId: string): Promise<void> {
        return await webhooksMethods.deleteWebhook(this.client, webhookId);
    }

    async getWebhookDeliveries(
        webhookId: string,
        params?: { limit?: number; offset?: number; status?: string; from?: string; to?: string }
    ): Promise<WebhookDeliveriesResponse> {
        return await webhooksMethods.getWebhookDeliveries(this.client, webhookId, params);
    }

    async testWebhook(webhookId: string): Promise<void> {
        return await webhooksMethods.testWebhook(this.client, webhookId);
    }

    async activateWebhook(webhookId: string): Promise<void> {
        return await webhooksMethods.activateWebhook(this.client, webhookId);
    }

    async deactivateWebhook(webhookId: string): Promise<void> {
        return await webhooksMethods.deactivateWebhook(this.client, webhookId);
    }

    async replayWebhookDelivery(webhookId: string, deliveryId: string): Promise<void> {
        return await webhooksMethods.replayWebhookDelivery(this.client, webhookId, deliveryId);
    }

    async getWebhookEvents(): Promise<WebhookEventsResponse> {
        return await webhooksMethods.getWebhookEvents(this.client);
    }

    // Monitors
    async createMonitor(input: CreateMonitorRequest): Promise<MonitorCreateResponse> {
        return await monitorsMethods.createMonitor(this.client, input);
    }

    async listMonitors(): Promise<Monitor[]> {
        return await monitorsMethods.listMonitors(this.client);
    }

    async getMonitor(monitorId: string): Promise<Monitor> {
        return await monitorsMethods.getMonitor(this.client, monitorId);
    }

    async updateMonitor(monitorId: string, input: UpdateMonitorRequest): Promise<Monitor> {
        return await monitorsMethods.updateMonitor(this.client, monitorId, input);
    }

    async deleteMonitor(monitorId: string): Promise<void> {
        return await monitorsMethods.deleteMonitor(this.client, monitorId);
    }

    async pauseMonitor(monitorId: string): Promise<void> {
        return await monitorsMethods.pauseMonitor(this.client, monitorId);
    }

    async resumeMonitor(monitorId: string): Promise<void> {
        return await monitorsMethods.resumeMonitor(this.client, monitorId);
    }

    async runMonitor(monitorId: string): Promise<void> {
        return await monitorsMethods.runMonitor(this.client, monitorId);
    }

    async getMonitorSnapshots(
        monitorId: string,
        params?: { limit?: number; offset?: number }
    ): Promise<MonitorSnapshot[]> {
        return await monitorsMethods.getMonitorSnapshots(this.client, monitorId, params);
    }

    async getMonitorChanges(
        monitorId: string,
        params?: { limit?: number; offset?: number }
    ): Promise<MonitorChange[]> {
        return await monitorsMethods.getMonitorChanges(this.client, monitorId, params);
    }

    async getMonitorChange(monitorId: string, changeId: string): Promise<MonitorChange> {
        return await monitorsMethods.getMonitorChange(this.client, monitorId, changeId);
    }

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
        return await crawlAndWaitMethod(
            this.client,
            input,
            pollIntervalSeconds,
            timeoutMs
        );
    }
}

export * from './types.js';


