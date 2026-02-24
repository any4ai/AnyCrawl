import type { AxiosInstance, AxiosResponse } from 'axios';
import type { ApiResponse, ScrapeRequest, ScrapeResult } from '../types.js';
import { omitUndefined } from '../utils/index.js';

export async function scrape(client: AxiosInstance, input: ScrapeRequest): Promise<ScrapeResult> {
    const body: any = { url: input.url, engine: input.engine ?? 'playwright' };
    if (input.proxy != null) body.proxy = input.proxy;
    if (input.formats != null) body.formats = input.formats;
    if (input.timeout != null) body.timeout = input.timeout;
    if (input.retry != null) body.retry = input.retry;
    if (input.wait_for != null) body.wait_for = input.wait_for;
    if (input.wait_until != null) body.wait_until = input.wait_until;
    if (input.include_tags != null) body.include_tags = input.include_tags;
    if (input.exclude_tags != null) body.exclude_tags = input.exclude_tags;
    if (input.json_options != null) body.json_options = input.json_options;
    if (input.extract_source != null) body.extract_source = input.extract_source;
    if (input.max_age != null) body.max_age = input.max_age;
    if (input.store_in_cache != null) body.store_in_cache = input.store_in_cache;
    const response: AxiosResponse<ApiResponse<ScrapeResult>> = await client.post('/v1/scrape', body);
    if (!response.data.success) throw new Error((response.data as any).error || 'Scraping failed');
    return (response.data as any).data;
}

