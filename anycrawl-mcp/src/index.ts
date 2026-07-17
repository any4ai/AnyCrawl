#!/usr/bin/env node

import { createRequire } from 'module';
import { FastMCP } from 'fastmcp';
import { logger } from './logger.js';
import { AnyCrawlMCPServer } from './mcp-server.js';
import { extractApiKey, normalizeApiKey, validateApiKey } from './auth.js';

const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../package.json') as { version: string };
const serverVersion = packageVersion as `${number}.${number}.${number}`;

// Session data
interface SessionData extends Record<string, unknown> {
    anycrawlApiKey: string;
    baseUrl?: string;
}

// Create FastMCP server instance (single port)
const server = new FastMCP<SessionData>({
    name: 'anycrawl-fastmcp',
    version: serverVersion,
    logger: {
        debug: (message: string, data?: any) => logger.debug(message, data),
        error: (message: string, data?: any) => logger.error(message, data),
        info: (message: string, data?: any) => logger.info(message, data),
        log: (message: string, data?: any) => logger.info(message, data),
        warn: (message: string, data?: any) => {
            // Suppress non-critical client capability warning
            if (message.includes('could not infer client capabilities')) {
                logger.debug('Suppressed client capabilities warning:', message);
                return;
            }
            logger.warn(message, data);
        },
    },
    roots: { enabled: false },
    authenticate: async (request: { headers: import('http').IncomingHttpHeaders }): Promise<SessionData> => {
        const baseUrl = process.env.ANYCRAWL_BASE_URL || 'https://api.anycrawl.dev';

        if (process.env.CLOUD_SERVICE === 'true') {
            const rawApiKey = extractApiKey(request.headers);
            if (!rawApiKey) {
                throw new Error(
                    'AnyCrawl API key is required. Use /{API_KEY}/mcp or set Authorization: Bearer <key>'
                );
            }

            const apiKey = normalizeApiKey(rawApiKey);
            await validateApiKey(apiKey, baseUrl);
            return { anycrawlApiKey: apiKey, baseUrl };
        }

        return {
            anycrawlApiKey: process.env.ANYCRAWL_API_KEY || '',
            baseUrl,
        };
    },
    // Health endpoint
    health: {
        enabled: true,
        message: 'ok',
        path: '/health',
        status: 200,
    },
});

// Create AnyCrawl MCP server per session
function getAnyCrawlMCPServer(session: SessionData): AnyCrawlMCPServer {
    return new AnyCrawlMCPServer(session.anycrawlApiKey, session.baseUrl);
}


// Get tool definitions from AnyCrawlMCPServer
const tempServer = new AnyCrawlMCPServer('temp', undefined);
const toolDefinitions = tempServer.getToolDefinitions();

// Register tools to the FastMCP instance
function addToolsToServer(serverInstance: FastMCP<SessionData>) {
    toolDefinitions.forEach((toolDef: { name: string; description: string; parameters: any }) => {
        serverInstance.addTool({
            name: toolDef.name,
            description: toolDef.description,
            parameters: toolDef.parameters,
            execute: async (args, context) => {
                const mcpServer = getAnyCrawlMCPServer(context.session!);

                try {
                    context.log.info(`Executing ${toolDef.name} tool`, { args: JSON.stringify(args) });

                    // FastMCP passes args as the first parameter, not as arguments property
                    const result = await mcpServer.handleToolCall({ name: toolDef.name, arguments: args || {} });

                    return {
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    context.log.error(`${toolDef.name} tool execution failed`, { error: errorMessage });
                    throw new Error(`${toolDef.name} failed: ${errorMessage}`);
                }
            },
            annotations: {
                readOnlyHint: toolDef.name !== 'anycrawl_cancel_crawl',
                openWorldHint: ['anycrawl_scrape', 'anycrawl_crawl', 'anycrawl_search'].includes(toolDef.name),
                destructiveHint: toolDef.name === 'anycrawl_cancel_crawl'
            }
        });
    });
}

// Add tools to the single server instance
addToolsToServer(server);

// Main execution function
async function main() {
    const mode = process.env.ANYCRAWL_MODE || 'STDIO';

    try {
        if (mode === 'MCP') {
            // MCP(JSON) mode for Cursor streamable_http
            const port = Number(process.env.ANYCRAWL_PORT || process.env.ANYCRAWL_MCP_PORT || 3000);
            const host = process.env.ANYCRAWL_HOST || 'mcp.anycrawl.dev';
            const isLocalHost = process.env.ANYCRAWL_HOST !== undefined;
            const endpointUrl = isLocalHost ? `http://${host}:${port}/mcp` : `https://${host}/mcp`;

            logger.info(`Starting AnyCrawl FastMCP Server in MCP(JSON) mode`);
            logger.info(`   MCP endpoint: ${endpointUrl}`);

            await server.start({
                transportType: 'httpStream',
                httpStream: {
                    host,
                    port,
                    stateless: false,
                    enableJsonResponse: true,
                    endpoint: '/mcp'
                }
            });
        } else if (mode === 'SSE') {
            // SSE mode for web/browser clients
            const port = Number(process.env.ANYCRAWL_PORT || process.env.ANYCRAWL_SSE_PORT || 3000);
            const host = process.env.ANYCRAWL_HOST || 'mcp.anycrawl.dev';
            const isLocalHost = process.env.ANYCRAWL_HOST !== undefined;
            const endpointUrl = isLocalHost ? `http://${host}:${port}/sse` : `https://${host}/sse`;

            logger.info(`Starting AnyCrawl FastMCP Server in SSE mode`);
            logger.info(`   SSE endpoint: ${endpointUrl}`);

            await server.start({
                transportType: 'httpStream',
                httpStream: {
                    host,
                    port,
                    stateless: true
                }
            });
        } else {
            logger.info('Starting AnyCrawl FastMCP Server in STDIO mode');
            await server.start({
                transportType: 'stdio'
            });
        }
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    server.stop().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    server.stop().then(() => process.exit(0));
});

// Start the server
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        logger.error('Unhandled error in main:', error);
        process.exit(1);
    });
}

export { main };
