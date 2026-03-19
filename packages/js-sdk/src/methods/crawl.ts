import type { AxiosInstance, AxiosResponse } from 'axios';
import type {
    CrawlAndWaitResult,
    CrawlJobResponse,
    CrawlRequest,
    CrawlResultsResponse,
    CrawlStatus,
    CrawlStatusResponse,
} from '../types.js';
import { buildCrawlScrapeOptions, unwrapApiResponse } from '../utils/index.js';
import { sleep } from '../utils/index.js';

export async function createCrawl(client: AxiosInstance, input: CrawlRequest): Promise<CrawlJobResponse> {
    const scrape_options = buildCrawlScrapeOptions(input);
    const body: any = { url: input.url, engine: input.engine ?? 'auto' };
    if (input.template_id != null) body.template_id = input.template_id;
    if (input.variables != null) body.variables = input.variables;
    if (input.exclude_paths != null) body.exclude_paths = input.exclude_paths;
    if (input.include_paths != null) body.include_paths = input.include_paths;
    if (input.scrape_paths != null) body.scrape_paths = input.scrape_paths;
    if (input.max_depth != null) body.max_depth = input.max_depth;
    if (input.strategy != null) body.strategy = input.strategy;
    if (input.limit != null) body.limit = input.limit;
    if (input.retry != null) body.retry = input.retry;
    if (scrape_options && Object.keys(scrape_options).length > 0) body.scrape_options = scrape_options;
    const response: AxiosResponse<unknown> = await client.post('/v1/crawl', body);
    return unwrapApiResponse<CrawlJobResponse>(response.data, 'Crawl creation failed');
}

export async function getCrawlStatus(client: AxiosInstance, jobId: string): Promise<CrawlStatusResponse> {
    const response: AxiosResponse<any> = await client.get(`/v1/crawl/${jobId}/status`);
    const payload: any = response.data;
    if (!payload.success) throw new Error(payload.error || 'Failed to get crawl status');
    return payload.data as CrawlStatusResponse;
}

export async function getCrawlResults(
    client: AxiosInstance,
    jobId: string,
    skip: number = 0
): Promise<CrawlResultsResponse> {
    const safeSkip = Math.max(0, Math.floor(Number(skip) || 0));
    const response: AxiosResponse<any> = await client.get(`/v1/crawl/${jobId}?skip=${safeSkip}`);
    const raw = response.data;
    if (!raw || raw.success === false) {
        throw new Error((raw?.error ?? raw?.message) || 'Failed to get crawl results');
    }
    return {
        ...raw,
        creditsUsed: raw.credits_used ?? raw.creditsUsed ?? 0,
    } as CrawlResultsResponse;
}

/**
 * Create a crawl and block until it finishes, then return all aggregated results.
 * Internal helper used by AnyCrawlClient.crawl().
 */
export async function crawlAndWait(
    client: AxiosInstance,
    input: CrawlRequest,
    pollIntervalSeconds: number = 2,
    timeoutMs?: number
): Promise<CrawlAndWaitResult> {
    const started = await createCrawl(client, input);
    const jobId = started.job_id;

    const startedAt = Date.now();
    let finalStatus: CrawlStatus = 'completed';

    while (true) {
        const status = await getCrawlStatus(client, jobId);
        finalStatus = status.status;
        if (status.status === 'completed') break;
        if (status.status === 'failed') {
            throw new Error(`Crawl failed (job_id=${jobId})`);
        }
        if (status.status === 'cancelled') {
            break;
        }

        if (timeoutMs !== undefined && Date.now() - startedAt > timeoutMs) {
            throw new Error(`Crawl timed out after ${timeoutMs}ms (job_id=${jobId})`);
        }

        await sleep(pollIntervalSeconds);
    }

    const aggregated: any[] = [];
    let skip = 0;
    let total = 0;
    let completed = 0;
    let creditsUsed = 0;
    while (true) {
        const page = await getCrawlResults(client, jobId, skip);
        if (typeof page.total === 'number') total = page.total;
        if (typeof page.completed === 'number') completed = page.completed;
        if (typeof page.creditsUsed === 'number') creditsUsed = page.creditsUsed;

        if (Array.isArray(page.data) && page.data.length > 0) {
            aggregated.push(...page.data);
        }

        if (page.next) {
            skip = aggregated.length;
        } else {
            break;
        }
    }

    return {
        job_id: jobId,
        status: finalStatus,
        total,
        completed,
        creditsUsed,
        data: aggregated,
    };
}


