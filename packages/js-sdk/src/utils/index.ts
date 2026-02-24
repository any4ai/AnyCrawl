import type { CrawlRequest, SearchRequest, ScrapeOptionsInput, Engine } from '../types.js';

export function omitUndefined<T extends Record<string, any>>(obj: T | undefined): Partial<T> {
    if (!obj || typeof obj !== 'object') return {} as Partial<T>;
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) cleaned[key] = value;
    }
    return cleaned;
}

export async function sleep(seconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

/**
 * Merge crawl top-level scrape fields with nested scrape_options, nested wins.
 * Strips disallowed keys for nested options (retry, extract_source) and undefineds.
 */
export function buildCrawlScrapeOptions(
    input: CrawlRequest
): Partial<Omit<ScrapeOptionsInput, 'retry'>> {
    const merged: Partial<Omit<ScrapeOptionsInput, 'retry'>> = {};
    // Only nested scrape_options are considered for crawl
    if (input.scrape_options) {
        const nested = input.scrape_options;
        if (nested.proxy != null) merged.proxy = nested.proxy;
        if (nested.formats != null) merged.formats = nested.formats;
        if (nested.timeout != null) merged.timeout = nested.timeout;
        if (nested.wait_for != null) merged.wait_for = nested.wait_for;
        if (nested.wait_until != null) merged.wait_until = nested.wait_until;
        if (nested.include_tags != null) merged.include_tags = nested.include_tags;
        if (nested.exclude_tags != null) merged.exclude_tags = nested.exclude_tags;
        if (nested.json_options != null) merged.json_options = nested.json_options;
        if (nested.extract_source != null) merged.extract_source = nested.extract_source;
        if (nested.max_age != null) merged.max_age = nested.max_age;
        if (nested.store_in_cache != null) merged.store_in_cache = nested.store_in_cache;
    }
    return merged;
}

/**
 * Clean search scrape_options by removing undefined and disallowed keys.
 */
export function buildSearchScrapeOptions(
    options: SearchRequest['scrape_options']
): SearchRequest['scrape_options'] | undefined {
    if (!options) return undefined;
    const out: SearchRequest['scrape_options'] = { engine: options.engine as Engine };
    if (options.proxy != null) out.proxy = options.proxy;
    if (options.formats != null) out.formats = options.formats;
    if (options.timeout != null) out.timeout = options.timeout;
    if (options.wait_for != null) out.wait_for = options.wait_for;
    if (options.wait_until != null) out.wait_until = options.wait_until;
    if (options.include_tags != null) out.include_tags = options.include_tags;
    if (options.exclude_tags != null) out.exclude_tags = options.exclude_tags;
    if (options.json_options != null) out.json_options = options.json_options;
    if (options.extract_source != null) out.extract_source = options.extract_source;
    if (options.max_age != null) out.max_age = options.max_age;
    if (options.store_in_cache != null) out.store_in_cache = options.store_in_cache;
    return out;
}
