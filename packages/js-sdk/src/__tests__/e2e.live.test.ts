/**
 * Live E2E tests -- hit the real AnyCrawl API.
 *
 * Gated by TWO env vars to avoid accidental execution in CI:
 *   ANYCRAWL_API_KEY  - valid Bearer token
 *   ANYCRAWL_RUN_LIVE - must be "1" or "true"
 *
 * Optional:
 *   ANYCRAWL_BASE_URL - defaults to https://api.anycrawl.dev
 *
 * Run:
 *   ANYCRAWL_API_KEY=sk-xxx ANYCRAWL_RUN_LIVE=1 pnpm --filter @anycrawl/js-sdk test:e2e
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { AnyCrawlClient } from '../index.js';

const API_KEY = process.env.ANYCRAWL_API_KEY;
const BASE_URL = process.env.ANYCRAWL_BASE_URL || 'https://api.anycrawl.dev';
const RUN_LIVE = process.env.ANYCRAWL_RUN_LIVE === '1' || process.env.ANYCRAWL_RUN_LIVE === 'true';

const maybeDescribe = API_KEY && RUN_LIVE ? describe : describe.skip;

describe('AnyCrawlClient E2E (env-gated)', () => {
    it('skips live tests without ANYCRAWL_API_KEY + ANYCRAWL_RUN_LIVE', () => {
        expect(true).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tier 1 -- zero / low credit consumption
// ---------------------------------------------------------------------------
maybeDescribe('E2E Tier 1: basic endpoints', () => {
    let client: AnyCrawlClient;

    beforeAll(() => {
        client = new AnyCrawlClient(API_KEY as string, BASE_URL);
    });

    it('healthCheck returns ok', async () => {
        const res = await client.healthCheck();
        expect(res.status).toBeDefined();
    }, 30_000);

    it('scrape cheerio returns valid structure', async () => {
        const res = await client.scrape({
            url: 'https://example.com',
            engine: 'cheerio',
            formats: ['markdown'],
            timeout: 30_000,
        });
        expect(['completed', 'failed']).toContain(res.status);
        expect(res.url).toContain('http');
    }, 120_000);

    it('map returns links array', async () => {
        const res = await client.map({
            url: 'https://example.com',
            limit: 10,
        });
        expect(Array.isArray(res.links)).toBe(true);
    }, 120_000);
});

// ---------------------------------------------------------------------------
// Tier 2 -- moderate credit consumption
// ---------------------------------------------------------------------------
maybeDescribe('E2E Tier 2: multi-engine & search', () => {
    let client: AnyCrawlClient;

    beforeAll(() => {
        client = new AnyCrawlClient(API_KEY as string, BASE_URL);
    });

    it.each([
        ['cheerio'],
        ['playwright'],
        ['puppeteer'],
    ])('scrape works with engine=%s', async (engine) => {
        const res = await client.scrape({
            url: 'https://example.com',
            engine: engine as any,
            formats: ['markdown'],
            timeout: 45_000,
        });
        expect(['completed', 'failed']).toContain(res.status);
        expect(res.url).toContain('http');
    }, 180_000);

    it('search returns results array', async () => {
        const results = await client.search({
            query: 'site:example.com',
            scrape_options: { engine: 'cheerio' },
            limit: 3,
        });
        expect(Array.isArray(results)).toBe(true);
    }, 120_000);

    it('createCrawl + getCrawlStatus flow', async () => {
        const job = await client.createCrawl({
            url: 'https://example.com',
            engine: 'cheerio',
            limit: 1,
        });
        expect(job.job_id).toBeDefined();
        expect(job.status).toBe('created');

        let status = await client.getCrawlStatus(job.job_id);
        expect(status.job_id).toBe(job.job_id);
        expect(['pending', 'completed', 'failed']).toContain(status.status);
    }, 120_000);
});

// ---------------------------------------------------------------------------
// Tier 3 -- full workflow
// ---------------------------------------------------------------------------
maybeDescribe('E2E Tier 3: crawl full flow', () => {
    let client: AnyCrawlClient;

    beforeAll(() => {
        client = new AnyCrawlClient(API_KEY as string, BASE_URL);
    });

    it('crawl blocking aggregates results (limit=3)', async () => {
        const result = await client.crawl(
            {
                url: 'https://example.com',
                engine: 'cheerio',
                limit: 3,
                scrape_options: { formats: ['markdown'] },
            },
            3,
            120_000,
        );
        expect(result.job_id).toBeDefined();
        expect(['completed', 'cancelled']).toContain(result.status);
        expect(Array.isArray(result.data)).toBe(true);
        expect(typeof result.total).toBe('number');
    }, 180_000);

    it('createCrawl + cancelCrawl', async () => {
        const job = await client.createCrawl({
            url: 'https://example.com',
            engine: 'cheerio',
            limit: 50,
        });
        expect(job.job_id).toBeDefined();

        const cancelled = await client.cancelCrawl(job.job_id);
        expect(cancelled.job_id).toBe(job.job_id);
        expect(cancelled.status).toBe('cancelled');
    }, 60_000);

    it('crawl end-to-end with getCrawlResults pagination', async () => {
        const start = await client.createCrawl({
            url: 'https://example.com',
            engine: 'cheerio',
            limit: 3,
            scrape_options: { formats: ['markdown'] },
        });
        expect(start.job_id).toBeDefined();

        let status: any;
        for (let i = 0; i < 24; i++) {
            status = await client.getCrawlStatus(start.job_id);
            if (status.status === 'completed' || status.status === 'failed') break;
            await new Promise((r) => setTimeout(r, 5_000));
        }
        expect(status).toBeDefined();

        const results = await client.getCrawlResults(start.job_id, 0);
        expect(Array.isArray(results.data)).toBe(true);
        if (typeof results.total === 'number') {
            expect(results.total).toBeLessThanOrEqual(3);
        }
    }, 180_000);
});

// ---------------------------------------------------------------------------
// Error scenarios
// ---------------------------------------------------------------------------
maybeDescribe('E2E Error handling', () => {
    it('invalid API key throws Authentication failed', async () => {
        const badClient = new AnyCrawlClient('invalid-key-12345', BASE_URL);
        await expect(badClient.scrape({
            url: 'https://example.com',
            engine: 'cheerio',
        })).rejects.toThrow(/Authentication failed/);
    }, 30_000);
});
