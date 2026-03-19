import {
    omitUndefined,
    buildCrawlScrapeOptions,
    buildSearchScrapeOptions,
    unwrapApiResponse,
    sleep,
} from '../utils/index.js';

describe('unwrapApiResponse', () => {
    it('should return data when success is true', () => {
        const data = { id: '1', name: 'test' };
        const result = unwrapApiResponse<typeof data>(
            { success: true, data },
            'fallback'
        );
        expect(result).toEqual(data);
    });

    it('should throw with error when success is false', () => {
        expect(() =>
            unwrapApiResponse({ success: false, error: 'API error' }, 'fallback')
        ).toThrow('API error');
    });

    it('should throw with message when success is false and no error', () => {
        expect(() =>
            unwrapApiResponse(
                { success: false, message: 'Custom message' } as any,
                'fallback'
            )
        ).toThrow('Custom message');
    });

    it('should throw errorFallback when success is false and no error/message', () => {
        expect(() =>
            unwrapApiResponse({ success: false } as any, 'My fallback')
        ).toThrow('My fallback');
    });

    it('should throw errorFallback when response is null', () => {
        expect(() => unwrapApiResponse(null, 'Null response')).toThrow(
            'Null response'
        );
    });

    it('should throw errorFallback when response is undefined', () => {
        expect(() => unwrapApiResponse(undefined, 'Undefined')).toThrow(
            'Undefined'
        );
    });

    it('should throw errorFallback when response is not an object', () => {
        expect(() => unwrapApiResponse('string', 'Not object')).toThrow(
            'Not object'
        );
    });

    it('should throw errorFallback when response has no success property', () => {
        expect(() => unwrapApiResponse({ foo: 'bar' }, 'No success')).toThrow(
            'No success'
        );
    });
});

describe('sleep', () => {
    it('should resolve after specified seconds', async () => {
        const start = Date.now();
        await sleep(0.02); // 20ms
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(15);
    });

    it('should handle negative seconds as 0', async () => {
        await expect(sleep(-1)).resolves.toBeUndefined();
    });
});

describe('omitUndefined', () => {
    it('should remove undefined values', () => {
        const result = omitUndefined({ a: 1, b: undefined, c: 'x' });
        expect(result).toEqual({ a: 1, c: 'x' });
    });

    it('should return empty object for undefined input', () => {
        expect(omitUndefined(undefined)).toEqual({});
    });

    it('should return empty object for non-object input', () => {
        expect(omitUndefined(null as any)).toEqual({});
    });

    it('should keep null values', () => {
        const result = omitUndefined({ a: null, b: undefined });
        expect(result).toEqual({ a: null });
    });
});

describe('buildCrawlScrapeOptions', () => {
    it('should return empty object when no scrape_options', () => {
        const result = buildCrawlScrapeOptions({
            url: 'https://example.com',
            engine: 'cheerio',
        });
        expect(result).toEqual({});
    });

    it('should extract nested scrape_options fields', () => {
        const result = buildCrawlScrapeOptions({
            url: 'https://example.com',
            engine: 'playwright',
            scrape_options: {
                formats: ['markdown', 'html'],
                timeout: 60000,
                only_main_content: true,
            },
        });
        expect(result).toEqual({
            formats: ['markdown', 'html'],
            timeout: 60000,
            only_main_content: true,
        });
    });

    it('should omit retry from scrape_options (crawl-level only)', () => {
        const result = buildCrawlScrapeOptions({
            url: 'https://example.com',
            engine: 'cheerio',
            scrape_options: {
                formats: ['markdown'],
                retry: true, // not a valid scrape_option for nested - types may allow it
            } as any,
        });
        expect(result).not.toHaveProperty('retry');
    });

    it('should include proxy, wait_for_selector, json_options', () => {
        const result = buildCrawlScrapeOptions({
            url: 'https://example.com',
            engine: 'cheerio',
            scrape_options: {
                proxy: 'http://proxy:8080',
                wait_for_selector: '.content',
                json_options: { schema: { type: 'object' } },
            },
        });
        expect(result).toEqual({
            proxy: 'http://proxy:8080',
            wait_for_selector: '.content',
            json_options: { schema: { type: 'object' } },
        });
    });

    it('should include extract_source, ocr_options, max_age, store_in_cache', () => {
        const result = buildCrawlScrapeOptions({
            url: 'https://example.com',
            engine: 'cheerio',
            scrape_options: {
                extract_source: 'markdown',
                ocr_options: true,
                max_age: 3600,
                store_in_cache: true,
            },
        });
        expect(result).toEqual({
            extract_source: 'markdown',
            ocr_options: true,
            max_age: 3600,
            store_in_cache: true,
        });
    });
});

describe('buildSearchScrapeOptions', () => {
    it('should return undefined when options is null/undefined', () => {
        expect(buildSearchScrapeOptions(undefined)).toBeUndefined();
        expect(buildSearchScrapeOptions(null as any)).toBeUndefined();
    });

    it('should return undefined when engine is missing', () => {
        expect(
            buildSearchScrapeOptions({ formats: ['markdown'] } as any)
        ).toBeUndefined();
    });

    it('should return undefined when engine is null', () => {
        expect(
            buildSearchScrapeOptions({ engine: null } as any)
        ).toBeUndefined();
    });

    it('should return engine-only when only engine provided', () => {
        const result = buildSearchScrapeOptions({ engine: 'cheerio' });
        expect(result).toEqual({ engine: 'cheerio' });
    });

    it('should include all defined scrape fields when engine present', () => {
        const result = buildSearchScrapeOptions({
            engine: 'playwright',
            formats: ['markdown', 'html'],
            timeout: 30000,
        });
        expect(result).toEqual({
            engine: 'playwright',
            formats: ['markdown', 'html'],
            timeout: 30000,
        });
    });

    it('should include wait_for, wait_until, wait_for_selector, include_tags, exclude_tags, only_main_content', () => {
        const result = buildSearchScrapeOptions({
            engine: 'playwright',
            wait_for: 3000,
            wait_until: 'networkidle',
            wait_for_selector: '.main',
            include_tags: ['article'],
            exclude_tags: ['nav'],
            only_main_content: true,
        });
        expect(result).toEqual({
            engine: 'playwright',
            wait_for: 3000,
            wait_until: 'networkidle',
            wait_for_selector: '.main',
            include_tags: ['article'],
            exclude_tags: ['nav'],
            only_main_content: true,
        });
    });

    it('should include json_options, extract_source, ocr_options, max_age, store_in_cache, proxy', () => {
        const result = buildSearchScrapeOptions({
            engine: 'cheerio',
            json_options: { schema: { type: 'object' } },
            extract_source: 'markdown',
            ocr_options: true,
            max_age: 3600,
            store_in_cache: true,
            proxy: 'http://proxy:8080',
        });
        expect(result).toEqual({
            engine: 'cheerio',
            json_options: { schema: { type: 'object' } },
            extract_source: 'markdown',
            ocr_options: true,
            max_age: 3600,
            store_in_cache: true,
            proxy: 'http://proxy:8080',
        });
    });
});
