import type { AxiosInstance, AxiosResponse } from 'axios';
import type { ScrapeRequest, ScrapeResult } from '../types.js';
import { unwrapApiResponse } from '../utils/index.js';

export async function scrape(client: AxiosInstance, input: ScrapeRequest): Promise<ScrapeResult> {
    const body: any = { url: input.url, engine: input.engine ?? 'auto' };
    if (input.template_id != null) body.template_id = input.template_id;
    if (input.variables != null) body.variables = input.variables;
    if (input.proxy != null) body.proxy = input.proxy;
    if (input.formats != null) body.formats = input.formats;
    if (input.timeout != null) body.timeout = input.timeout;
    if (input.retry != null) body.retry = input.retry;
    if (input.wait_for != null) body.wait_for = input.wait_for;
    if (input.wait_until != null) body.wait_until = input.wait_until;
    if (input.wait_for_selector != null) body.wait_for_selector = input.wait_for_selector;
    if (input.include_tags != null) body.include_tags = input.include_tags;
    if (input.exclude_tags != null) body.exclude_tags = input.exclude_tags;
    if (input.only_main_content != null) body.only_main_content = input.only_main_content;
    if (input.json_options != null) body.json_options = input.json_options;
    if (input.extract_source != null) body.extract_source = input.extract_source;
    if (input.ocr_options != null) body.ocr_options = input.ocr_options;
    if (input.max_age != null) body.max_age = input.max_age;
    if (input.store_in_cache != null) body.store_in_cache = input.store_in_cache;
    const response: AxiosResponse<unknown> = await client.post('/v1/scrape', body);
    return unwrapApiResponse<ScrapeResult>(response.data, 'Scraping failed');
}

