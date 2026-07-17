import { AnyCrawlMCPServer } from '../mcp-server';

describe('AnyCrawlMCPServer tool handlers', () => {
    const API_KEY = 'test-key';

    function serverWithMockedClient() {
        const server = new AnyCrawlMCPServer(API_KEY);
        const mockedClient = {
            scrape: jest.fn(),
            crawl: jest.fn(),
            getCrawlStatus: jest.fn(),
            getCrawlResults: jest.fn(),
            cancelCrawl: jest.fn(),
            search: jest.fn(),
        } as any;
        (server as any)['client'] = mockedClient;
        return { server, client: mockedClient };
    }

    test('anycrawl_scrape success', async () => {
        const { server, client } = serverWithMockedClient();
        (client.scrape as any).mockResolvedValue({
            url: 'https://example.com',
            status: 'completed',
            markdown: '# hi',
            timestamp: 'now',
        });

        const res = await server.handleToolCall({
            name: 'anycrawl_scrape',
            arguments: { url: 'https://example.com', engine: 'cheerio' },
        });

        const body = JSON.parse((res.content[0] as any).text);
        expect(body.url).toBe('https://example.com');
        expect(body.status).toBe('completed');
        expect(client.scrape).toHaveBeenCalled();
    });

    test('anycrawl_scrape failure returns isError', async () => {
        const { server, client } = serverWithMockedClient();
        (client.scrape as any).mockResolvedValue({
            url: 'https://bad.com',
            status: 'failed',
            error: 'boom',
        });

        const res = await server.handleToolCall({
            name: 'anycrawl_scrape',
            arguments: { url: 'https://bad.com', engine: 'cheerio' },
        });

        expect(res.isError).toBe(true);
    });

    test('anycrawl_crawl aggregates results', async () => {
        const { server, client } = serverWithMockedClient();
        (client.crawl as any).mockResolvedValue({
            job_id: 'jid',
            status: 'completed',
            total: 1,
            completed: 1,
            creditsUsed: 0,
            data: [{ url: 'https://a.com' }],
        });

        const res = await server.handleToolCall({
            name: 'anycrawl_crawl',
            arguments: { url: 'https://site.com', engine: 'cheerio', scrape_options: { formats: ['html', 'markdown'] } },
        });
        const body = JSON.parse((res.content[0] as any).text);
        expect(body.status).toBe('completed');
        expect(client.crawl).toHaveBeenCalled();
    });

    test('anycrawl_crawl_status returns mapped fields', async () => {
        const { server, client } = serverWithMockedClient();
        (client.getCrawlStatus as any).mockResolvedValue({
            job_id: 'jid',
            status: 'pending',
            start_time: 't0',
            expires_at: 't1',
            credits_used: 1,
            total: 2,
            completed: 1,
            failed: 0,
        });
        const res = await server.handleToolCall({
            name: 'anycrawl_crawl_status',
            arguments: { job_id: 'jid' },
        });
        const body = JSON.parse((res.content[0] as any).text);
        expect(body.job_id).toBe('jid');
        expect(body.status).toBe('pending');
    });

    test('anycrawl_crawl_results returns data and next', async () => {
        const { server, client } = serverWithMockedClient();
        (client.getCrawlResults as any).mockResolvedValue({
            status: 'completed',
            total: 3,
            completed: 3,
            creditsUsed: 10,
            next: undefined,
            data: [{ id: 1 }],
        });
        const res = await server.handleToolCall({
            name: 'anycrawl_crawl_results',
            arguments: { job_id: 'jid' },
        });
        const body = JSON.parse((res.content[0] as any).text);
        expect(body.total).toBe(3);
        expect(Array.isArray(body.data)).toBe(true);
    });

    test('anycrawl_cancel_crawl returns text message', async () => {
        const { server, client } = serverWithMockedClient();
        (client.cancelCrawl as any).mockResolvedValue({ job_id: 'jid', status: 'cancelled' });
        const res = await server.handleToolCall({
            name: 'anycrawl_cancel_crawl',
            arguments: { job_id: 'jid' },
        });
        expect((res.content[0] as any).text).toMatch(/cancelled/);
    });

    test('anycrawl_search returns array json text', async () => {
        const { server, client } = serverWithMockedClient();
        (client.search as any).mockResolvedValue([{ title: 't', source: 'google' }]);
        const res = await server.handleToolCall({
            name: 'anycrawl_search',
            arguments: { query: 'q', scrape_options: { engine: 'cheerio' } },
        });
        const body = JSON.parse((res.content[0] as any).text);
        expect(Array.isArray(body)).toBe(true);
        expect(client.search).toHaveBeenCalled();
    });

    test('anycrawl_search returns error when SDK throws', async () => {
        const { server, client } = serverWithMockedClient();
        (client.search as any).mockRejectedValue(new Error('network down'));
        const res = await server.handleToolCall({ name: 'anycrawl_search', arguments: { query: 'q' } });
        expect(res.isError).toBe(true);
        expect((res.content[0] as any).text).toMatch(/failed|error/i);
    });

    test('anycrawl_crawl throws when SDK returns unexpected payload', async () => {
        const { server, client } = serverWithMockedClient();
        (client.crawl as any).mockResolvedValue(undefined);
        const out = await server.handleToolCall({ name: 'anycrawl_crawl', arguments: { url: 'https://x.com', engine: 'cheerio' } });
        // Should return a valid tool result shape
        expect(out).toBeTruthy();
        expect(Array.isArray(out.content)).toBe(true);
    });
});


