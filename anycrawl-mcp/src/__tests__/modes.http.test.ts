import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { AnyCrawlMCPServer } from '../mcp-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

jest.setTimeout(20000);

describe('Server modes', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...OLD_ENV };
    });

    afterAll(() => {
        process.env = OLD_ENV;
    });

    test('CLOUD_SERVICE mode handles POST /mcp and returns JSON', async () => {
        process.env.ANYCRAWL_MODE = 'CLOUD_SERVICE';
        process.env.ANYCRAWL_API_KEY = 'test';

        const app = express();
        app.use(helmet());
        app.use(express.json({ limit: '1mb' }));
        app.use(cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'], allowedHeaders: ['Content-Type', 'mcp-session-id'] }));

        const srv = new AnyCrawlMCPServer('test');
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        // Inline minimal bridge (avoid depending on server.connectTransport)
        (transport as any).onmessage = async (message: any) => {
            const id = message?.id;
            if (message?.method === 'initialize') {
                await (transport as any).send({ jsonrpc: '2.0', id, result: { capabilities: {}, serverInfo: { name: 'AnyCrawl MCP Server', version: '1.0.0' } } });
                return;
            }
            if (message?.method === 'tools/list') {
                const tools = (srv as any).getToolDefinitions().map((t: any) => ({ name: t.name, description: t.description }));
                await (transport as any).send({ jsonrpc: '2.0', id, result: { tools } });
                return;
            }
            if (message?.method === 'tools/call') {
                const params = message.params || {};
                const result = await (srv as any).handleToolCall({ name: params.name, arguments: params.arguments || {} });
                await (transport as any).send({ jsonrpc: '2.0', id, result });
                return;
            }
            await (transport as any).send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
        };

        // override app post handler to simulate main() behavior quickly
        app.post('/mcp', async (req: Request, res: Response) => {
            await transport.handleRequest(req, res, req.body);
        });

        const httpServer = await new Promise<import('http').Server>((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        try {
            const address = httpServer.address();
            if (!address || typeof address === 'string') throw new Error('bad address');
            const baseUrl = `http://127.0.0.1:${address.port}`;

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
            const json = await initResp.json();
            expect(json.result).toBeTruthy();

            // Invalid call should respond with error
            const badCall = await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'application/json',
                    'Mcp-Protocol-Version': '2025-03-26',
                } as any,
                body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'anycrawl_scrape', arguments: { url: 'bad-url' } } }),
            });
            const badJson = await badCall.json();
            expect(badJson.result?.isError || badJson.error).toBeTruthy();
        } finally {
            await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        }
    });
});
