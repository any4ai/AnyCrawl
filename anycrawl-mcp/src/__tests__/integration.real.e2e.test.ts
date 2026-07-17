import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import axios from 'axios';
import { AnyCrawlMCPServer } from '../mcp-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Only run if explicitly enabled and a real API key is provided
const shouldRunReal = process.env.RUN_REAL_E2E === '1' && !!process.env.ANYCRAWL_API_KEY;
const maybeTest = shouldRunReal ? test : test.skip;

describe('REAL API e2e (requires ANYCRAWL_API_KEY)', () => {
    maybeTest('scrape, crawl, search via in-process HTTP transport', async () => {
        const apiKey = process.env.ANYCRAWL_API_KEY as string;
        const baseApi = process.env.ANYCRAWL_BASE_URL || 'https://api.anycrawl.dev';

        // Start in-process HTTP transport server
        const app = express();
        app.use(helmet());
        app.use(express.json({ limit: '1mb' }));
        app.use(cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'], allowedHeaders: ['Content-Type', 'mcp-session-id'] }));

        const server = new AnyCrawlMCPServer(apiKey, baseApi);

        // Inject a minimal real HTTP client using axios to avoid ESM import issues and jest mappers
        const http = axios.create({
            baseURL: baseApi,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 300000,
        });
        const realClient = {
            async scrape(input: any) {
                const body: any = { url: input.url, engine: input.engine };
                if (input.proxy != null) body.proxy = input.proxy;
                if (input.formats != null) body.formats = input.formats;
                if (input.timeout != null) body.timeout = input.timeout;
                if (input.retry != null) body.retry = input.retry;
                if (input.wait_for != null) body.wait_for = input.wait_for;
                if (input.include_tags != null) body.include_tags = input.include_tags;
                if (input.exclude_tags != null) body.exclude_tags = input.exclude_tags;
                if (input.json_options != null) body.json_options = input.json_options;
                if (input.extract_source != null) body.extract_source = input.extract_source;
                const resp = await http.post('/v1/scrape', body);
                if (!resp.data?.success) throw new Error(resp.data?.error || 'Scraping failed');
                return resp.data.data;
            },
            async createCrawl(input: any) {
                const body: any = { url: input.url, engine: input.engine };
                if (input.exclude_paths != null) body.exclude_paths = input.exclude_paths;
                if (input.include_paths != null) body.include_paths = input.include_paths;
                if (input.max_depth != null) body.max_depth = input.max_depth;
                if (input.strategy != null) body.strategy = input.strategy;
                if (input.limit != null) body.limit = input.limit;
                if (input.retry != null) body.retry = input.retry;
                const resp = await http.post('/v1/crawl', body);
                if (!resp.data?.success) throw new Error(resp.data?.error || 'Crawl creation failed');
                return resp.data.data;
            },
            async getCrawlStatus(jobId: string) {
                const resp = await http.get(`/v1/crawl/${jobId}/status`);
                const payload = resp.data;
                if (!payload?.success) throw new Error(payload?.error || 'Failed to get crawl status');
                return payload.data;
            },
            async getCrawlResults(jobId: string, skip = 0) {
                const resp = await http.get(`/v1/crawl/${jobId}?skip=${skip}`);
                return resp.data;
            },
            async crawl(input: any, pollIntervalSeconds = 2, timeoutMs = 60000) {
                const started = await (this as any).createCrawl(input);
                const jobId = started.job_id;
                const start = Date.now();
                while (true) {
                    const status = await (this as any).getCrawlStatus(jobId);
                    if (status.status === 'completed') break;
                    if (status.status === 'failed') throw new Error(`Crawl failed (job_id=${jobId})`);
                    if (status.status === 'cancelled') break;
                    if (Date.now() - start > timeoutMs) throw new Error(`Crawl timed out after ${timeoutMs}ms`);
                    await new Promise((r) => setTimeout(r, Math.max(1, pollIntervalSeconds) * 1000));
                }
                const aggregated: any[] = [];
                let skip = 0;
                let total = 0;
                let completed = 0;
                let creditsUsed = 0;
                while (true) {
                    const page = await (this as any).getCrawlResults(jobId, skip);
                    if (typeof page.total === 'number') total = page.total;
                    if (typeof page.completed === 'number') completed = page.completed;
                    if (typeof page.creditsUsed === 'number') creditsUsed = page.creditsUsed;
                    if (Array.isArray(page.data) && page.data.length > 0) aggregated.push(...page.data);
                    if (page.next) {
                        skip = aggregated.length;
                    } else {
                        break;
                    }
                }
                return { job_id: jobId, status: 'completed', total, completed, creditsUsed, data: aggregated };
            },
            async search(input: any) {
                const body: any = { query: input.query };
                if (input.engine != null) body.engine = input.engine;
                if (input.limit != null) body.limit = input.limit;
                if (input.offset != null) body.offset = input.offset;
                if (input.pages != null) body.pages = input.pages;
                if (input.lang != null) body.lang = input.lang;
                if (input.country != null) body.country = input.country;
                if (input.safeSearch != null) body.safeSearch = input.safeSearch;
                const resp = await http.post('/v1/search', body);
                if (!resp.data?.success) throw new Error(resp.data?.error || 'Search failed');
                return resp.data.data;
            },
        } as any;
        (server as any)['client'] = realClient;

        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'real-session', enableJsonResponse: true });
        // Inline bridge (compatible with current AnyCrawlMCPServer)
        (transport as any).onmessage = async (message: any) => {
            const id = message?.id;
            if (message?.method === 'initialize') {
                await (transport as any).send({ jsonrpc: '2.0', id, result: { capabilities: {}, serverInfo: { name: 'AnyCrawl MCP Server', version: '1.0.0' } } });
                return;
            }
            if (message?.method === 'tools/list') {
                const tools = (server as any).getToolDefinitions().map((t: any) => ({ name: t.name, description: t.description }));
                await (transport as any).send({ jsonrpc: '2.0', id, result: { tools } });
                return;
            }
            if (message?.method === 'tools/call') {
                const params = message.params || {};
                const result = await (server as any).handleToolCall({ name: params.name, arguments: params.arguments || {} });
                await (transport as any).send({ jsonrpc: '2.0', id, result });
                return;
            }
            await (transport as any).send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
        };

        app.post('/mcp', async (req: Request, res: Response) => {
            await transport.handleRequest(req, res, req.body);
        });

        const httpServer = await new Promise<import('http').Server>((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });

        try {
            const address = httpServer.address();
            if (!address || typeof address === 'string') throw new Error('invalid address');
            const baseUrl = `http://127.0.0.1:${address.port}`;

            // initialize to get session id
            const initResp = await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'application/json',
                    'Mcp-Protocol-Version': '2025-03-26',
                } as any,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: '2025-03-26', clientInfo: { name: 'jest', version: '0.0.0' }, capabilities: {} },
                }),
            });
            expect(initResp.status).toBe(200);
            const sessionId = initResp.headers.get('mcp-session-id');
            expect(sessionId).toBe('real-session');

            // Scrape
            const callResp = await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'application/json',
                    'Mcp-Protocol-Version': '2025-03-26',
                    'Mcp-Session-Id': sessionId!,
                } as any,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/call',
                    params: { name: 'anycrawl_scrape', arguments: { url: 'https://example.com', engine: 'cheerio', formats: ['markdown'] } },
                }),
            });
            const callJson = await callResp.json();
            if (callJson.error) {
                process.stdout.write(`REAL_SCRAPE_ERROR: ${JSON.stringify(callJson.error)}\n`);
                throw new Error(`Real scrape failed: ${callJson.error.message || 'unknown error'}`);
            }
            expect(callJson.result).toBeTruthy();
            const text = callJson.result.content?.[0]?.text as string;
            const parsed = JSON.parse(text);
            expect(parsed.url).toBe('https://example.com');
            expect(parsed.status).toBeDefined();

            // Crawl (small)
            const crawlResp = await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'application/json',
                    'Mcp-Protocol-Version': '2025-03-26',
                    'Mcp-Session-Id': sessionId!,
                } as any,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 3,
                    method: 'tools/call',
                    params: { name: 'anycrawl_crawl', arguments: { url: 'https://example.com', engine: 'cheerio', max_depth: 1, limit: 3, strategy: 'same-domain', poll_seconds: 2, timeout_ms: 30000 } },
                }),
            });
            const crawlJson = await crawlResp.json();
            if (crawlJson.error) {
                process.stdout.write(`REAL_CRAWL_ERROR: ${JSON.stringify(crawlJson.error)}\n`);
                throw new Error(`Real crawl failed: ${crawlJson.error.message || 'unknown error'}`);
            }
            const crawlText = crawlJson.result.content?.[0]?.text as string;
            const crawlParsed = JSON.parse(crawlText);
            expect(crawlParsed.status).toBeDefined();
            expect(Array.isArray(crawlParsed.data)).toBe(true);

            // Search
            const searchResp = await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'application/json',
                    'Mcp-Protocol-Version': '2025-03-26',
                    'Mcp-Session-Id': sessionId!,
                } as any,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 4,
                    method: 'tools/call',
                    params: { name: 'anycrawl_search', arguments: { query: 'example domain', engine: 'google', limit: 1, scrape_engine: 'cheerio', formats: ['markdown'] } },
                }),
            });
            const searchJson = await searchResp.json();
            if (searchJson.error) {
                process.stdout.write(`REAL_SEARCH_ERROR: ${JSON.stringify(searchJson.error)}\n`);
                throw new Error(`Real search failed: ${searchJson.error.message || 'unknown error'}`);
            }
            const searchText = searchJson.result.content?.[0]?.text as string;
            const searchParsed = JSON.parse(searchText) as any[];
            expect(Array.isArray(searchParsed)).toBe(true);
            expect(searchParsed.length).toBeGreaterThanOrEqual(1);
        } finally {
            await new Promise<void>((resolve) => httpServer.close(() => resolve()))
        }
    }, 120000);
});


