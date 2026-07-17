#!/usr/bin/env node

import {
    CallToolResult,
    TextContent,
    ErrorCode,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { AnyCrawlClient } from '@anycrawl/js-sdk';
import { logger } from './logger.js';
import { z } from 'zod';
import {
    ScrapeToolSchema,
    CrawlToolSchema,
    SearchToolSchema,
    CrawlStatusToolSchema,
    CrawlResultsToolSchema,
    CancelCrawlToolSchema,
} from './schemas.js';

export class AnyCrawlMCPServer {
    private client: AnyCrawlClient;

    constructor(apiKey: string, baseUrl?: string) {
        logger.info('Initializing AnyCrawl MCP Server');

        this.client = new AnyCrawlClient(apiKey, baseUrl);

        logger.info('AnyCrawl MCP Server initialized successfully');
    }

    // Get tool definitions for FastMCP integration
    public getToolDefinitions(): Array<{ name: string; description: string; parameters: any }> {
        return this.getToolDefinitionsInternal().map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
        }));
    }

    // Internal method to get tool definitions with zod schemas
    private getToolDefinitionsInternal(): Array<{ name: string; description: string; inputSchema: any }> {
        return [
            {
                name: 'anycrawl_scrape',
                description: `Scrape a single URL and extract content in selected formats.

Best for: One known page (articles, docs, product pages).
Not recommended for: Multi-page coverage (use anycrawl_crawl) or open-ended discovery (use anycrawl_search).

RECOMMENDED: Use 'auto' engine (default) to let the server automatically choose the best engine for the target URL.

Usage (parameters):
- url: HTTP/HTTPS URL to scrape (string, required)
- engine: 'auto' | 'playwright' | 'cheerio' | 'puppeteer' (optional, default: 'auto')
- proxy: Proxy URL (string, optional)
- formats: Output formats ['markdown'|'html'|'text'|'screenshot'|'screenshot@fullPage'|'rawHtml'|'json'] (optional)
- timeout: Request timeout in ms (number, optional)
- retry: Enable auto-retry on failure (boolean, optional)
- wait_for: Wait in ms for dynamic pages (number, optional)
- include_tags: HTML tags to include (string[], optional)
- exclude_tags: HTML tags to exclude (string[], optional)
- json_options: { schema?, user_prompt?, schema_name?, schema_description? } (optional)
- extract_source: 'html' | 'markdown' (optional)

Returns: { url, status, jobId?, title?, html?, markdown?, metadata?, timestamp? }

Examples:
- Recommended: { "url": "https://example.com" }
- With specific engine: { "url": "https://example.com", "engine": "playwright" }
- With JSON extraction: { "url": "https://news.ycombinator.com", "formats": ["markdown"], "json_options": { "user_prompt": "Extract titles", "schema_name": "Articles" } }
- With JSON schema extraction: { "url": "https://example.com/article", "json_options": { "schema_name": "Article", "schema_description": "Extract article metadata and content", "schema": { "type": "object", "properties": { "title": { "type": "string" }, "author": { "type": "string" }, "date": { "type": "string" }, "content": { "type": "string" } }, "required": ["title", "content"] } } }`,
                inputSchema: ScrapeToolSchema
            },
            {
                name: 'anycrawl_crawl',
                description: `Crawl an entire website with configurable depth and limits.

Best for: Multi-page coverage, site mapping, content discovery.
Not recommended for: Single pages (use anycrawl_scrape) or open-ended discovery (use anycrawl_search).

RECOMMENDED: Use 'auto' engine (default) to let the server automatically choose the best engine for each page.

Usage (parameters):
- url: Starting URL to crawl (string, required)
- engine: 'auto' | 'playwright' | 'cheerio' | 'puppeteer' (optional, default: 'auto')
- max_depth: Maximum crawl depth (number, optional, default: 10)
- limit: Maximum pages to crawl (number, optional, default: 100)
- strategy: Crawl strategy 'all' | 'same-domain' | 'same-hostname' | 'same-origin' (optional, default: 'same-domain')
- include_paths: Path patterns to include (string[], optional)
- exclude_paths: Path patterns to exclude (string[], optional)
- retry: Enable auto-retry on failure (boolean, optional)
- poll_seconds: Polling interval for job status (number, optional)
- poll_interval_ms: Polling interval in milliseconds (number, optional)
- timeout_ms: Job timeout in milliseconds (number, optional)
- scrape_options: Nested scrape options for each page (object, optional)

Returns: { job_id, status, message } for async jobs

Examples:
- Recommended: { "url": "https://example.com", "limit": 50 }
- With specific engine: { "url": "https://example.com", "engine": "playwright", "limit": 50 }
- Deep crawl: { "url": "https://docs.example.com", "max_depth": 5, "limit": 200 }
- Filtered crawl: { "url": "https://blog.example.com", "include_paths": ["/posts/*"], "exclude_paths": ["/admin/*"] }`,
                inputSchema: CrawlToolSchema
            },
            {
                name: 'anycrawl_search',
                description: `Search the web and optionally scrape results.

Best for: Open-ended discovery, finding relevant content.
Not recommended for: Known URLs (use anycrawl_scrape) or comprehensive site coverage (use anycrawl_crawl).

RECOMMENDED: Use limit=5 for balanced performance and cost. Use 'auto' engine (default) for scraping results.

Usage (parameters):
- query: Search query string (string, required)
- engine: Search engine 'google' (optional, default: 'google')
- limit: Number of results to return (number, optional, default: 5)
- offset: Number of results to skip (number, optional, default: 0)
- pages: Number of search result pages to process (number, optional)
- lang: Language code (string, optional)
- country: Country code (string, optional)
- safeSearch: Safe search level 0-2 (number, optional)
- scrape_options: Options for scraping search results (object, optional)

Returns: Array of search results with optional scraped content

Examples:
- Recommended: { "query": "artificial intelligence news", "limit": 5 }
- With scraping: { "query": "TypeScript tutorials", "limit": 5, "scrape_options": { "formats": ["markdown"] } }
- Localized search: { "query": "machine learning", "lang": "es", "country": "ES", "limit": 5 }`,
                inputSchema: SearchToolSchema
            },
            {
                name: 'anycrawl_crawl_status',
                description: `Get the status of a crawl job.

Check progress, completion status, and statistics for an ongoing or completed crawl job.

Usage (parameters):
- job_id: The crawl job ID (string, required)

Returns: { job_id, status, start_time, expires_at, credits_used, total, completed, failed }

Examples:
- Check status: { "job_id": "crawl_12345" }`,
                inputSchema: CrawlStatusToolSchema
            },
            {
                name: 'anycrawl_crawl_results',
                description: `Get the results of a completed crawl job.

Retrieve the scraped content and metadata from a completed crawl job.

Usage (parameters):
- job_id: The crawl job ID (string, required)
- skip: Number of results to skip (number, optional, default: 0)

Returns: { status, total, completed, creditsUsed, next?, data[] }

Examples:
- Get all results: { "job_id": "crawl_12345" }
- Paginated results: { "job_id": "crawl_12345", "skip": 50 }`,
                inputSchema: CrawlResultsToolSchema
            },
            {
                name: 'anycrawl_cancel_crawl',
                description: `Cancel a running crawl job.

Stop an ongoing crawl job and prevent further processing.

Usage (parameters):
- job_id: The crawl job ID to cancel (string, required)

Returns: { success: boolean, message: string }

Examples:
- Cancel job: { "job_id": "crawl_12345" }`,
                inputSchema: CancelCrawlToolSchema
            }
        ];
    }

    // Helper for tests to simulate tool calls without MCP transport
    public async handleToolCall(request: { name: string; arguments: any }): Promise<any> {
        const { name, arguments: args } = request as any;

        // Validate arguments
        if (!args || typeof args !== 'object') {
            logger.error(`Invalid arguments for tool ${name}:`, { args });
            return {
                content: [{ type: 'text', text: `Invalid arguments: expected object, got ${typeof args}` }],
                isError: true,
            };
        }

        try {
            logger.info(`Tool called: ${name}`, {
                tool: name,
                parameters: args,
                timestamp: new Date().toISOString()
            });
            switch (name) {
                case 'anycrawl_scrape':
                    {
                        const r = await this.handleScrape(args);
                        logger.info(`Tool ${name} completed successfully`, {
                            tool: name,
                            timestamp: new Date().toISOString()
                        });
                        return r;
                    }
                case 'anycrawl_crawl':
                    {
                        const r = await this.handleCrawl(args);
                        logger.info(`Tool ${name} completed successfully`, {
                            tool: name,
                            timestamp: new Date().toISOString()
                        });
                        return r;
                    }
                case 'anycrawl_crawl_status':
                    {
                        const r = await this.handleCrawlStatus(args);
                        logger.info(`Tool ${name} completed successfully`, {
                            tool: name,
                            timestamp: new Date().toISOString()
                        });
                        return r;
                    }
                case 'anycrawl_crawl_results':
                    {
                        const r = await this.handleCrawlResults(args);
                        logger.info(`Tool ${name} completed successfully`, {
                            tool: name,
                            timestamp: new Date().toISOString()
                        });
                        return r;
                    }
                case 'anycrawl_cancel_crawl':
                    {
                        const r = await this.handleCancelCrawl(args);
                        logger.info(`Tool ${name} completed successfully`, {
                            tool: name,
                            timestamp: new Date().toISOString()
                        });
                        return r;
                    }
                case 'anycrawl_search':
                    {
                        const r = await this.handleSearch(args);
                        logger.info(`Tool ${name} completed successfully`, {
                            tool: name,
                            timestamp: new Date().toISOString()
                        });
                        return r;
                    }
                default:
                    return {
                        content: [{ type: 'text', text: `Unknown tool: ${name}` as string }],
                        isError: true,
                    } as any;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error occurred';
            logger.error(`Tool ${name} failed:`, {
                tool: name,
                error: message,
                parameters: args,
                timestamp: new Date().toISOString()
            });
            return {
                content: [{ type: 'text', text: `Tool execution failed: ${message}` as string }],
                isError: true,
            } as any;
        }
    }


    private async handleScrape(args: any): Promise<CallToolResult> {
        logger.info(`Starting scrape for URL: ${args.url}`);
        const validatedArgs = ScrapeToolSchema.parse(args);
        const scrapeArgs: any = {
            url: validatedArgs.url,
            engine: validatedArgs.engine,
        };
        if ('proxy' in args) scrapeArgs.proxy = validatedArgs.proxy;
        if ('formats' in args) scrapeArgs.formats = validatedArgs.formats;
        if ('timeout' in args) scrapeArgs.timeout = validatedArgs.timeout;
        if ('retry' in args) scrapeArgs.retry = validatedArgs.retry;
        if ('wait_for' in args) scrapeArgs.wait_for = validatedArgs.wait_for;
        if ('include_tags' in args) scrapeArgs.include_tags = validatedArgs.include_tags;
        if ('exclude_tags' in args) scrapeArgs.exclude_tags = validatedArgs.exclude_tags;
        if ('json_options' in args) scrapeArgs.json_options = validatedArgs.json_options;
        if ('extract_source' in args) scrapeArgs.extract_source = validatedArgs.extract_source;

        const result = await this.client.scrape(scrapeArgs);

        if (!result || typeof (result as any).status !== 'string') {
            logger.error('Unexpected scrape result payload:', result as any);
            throw new McpError(ErrorCode.InternalError, 'Unexpected scrape result from AnyCrawl API');
        }

        if (result.status === 'failed') {
            logger.warn(`Scraping failed for ${result.url}: ${result.error}`);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Scraping failed for ${result.url}: ${result.error}`,
                    },
                ],
                isError: true,
            };
        }

        logger.info(`Scraping completed successfully for ${result.url}`);
        const response = {
            url: result.url,
            status: result.status,
            jobId: result.jobId,
            title: result.title,
            html: result.html,
            markdown: result.markdown,
            metadata: result.metadata,
            timestamp: result.timestamp,
        };

        const ret = {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(response, null, 2),
                } as TextContent,
            ],
        };
        logger.debug('Tool anycrawl_scrape completed successfully');
        return ret;
    }

    private async handleCrawl(args: any): Promise<CallToolResult> {
        logger.info(`Starting crawl for URL: ${args.url}`);
        const validatedArgs = CrawlToolSchema.parse(args);

        // Top-level crawl params (NOT part of ScrapeOptionsSchema)
        const crawlArgs: any = {
            url: validatedArgs.url,
        };
        if ('retry' in args) crawlArgs.retry = validatedArgs.retry;
        if ('exclude_paths' in args) crawlArgs.exclude_paths = validatedArgs.exclude_paths;
        if ('include_paths' in args) crawlArgs.include_paths = validatedArgs.include_paths;
        if ('max_depth' in args) crawlArgs.max_depth = validatedArgs.max_depth;
        if ('strategy' in args) crawlArgs.strategy = validatedArgs.strategy;
        if ('limit' in args) crawlArgs.limit = validatedArgs.limit;
        if ('engine' in args) crawlArgs.engine = validatedArgs.engine;

        // ScrapeOptionsSchema fields must be nested under scrape_options
        const scrapeOptions: any = {};
        if ('proxy' in args) scrapeOptions.proxy = validatedArgs.proxy;
        if ('formats' in args) scrapeOptions.formats = validatedArgs.formats;
        if ('timeout' in args) scrapeOptions.timeout = validatedArgs.timeout;
        if ('wait_for' in args) scrapeOptions.wait_for = validatedArgs.wait_for;
        if ('include_tags' in args) scrapeOptions.include_tags = validatedArgs.include_tags;
        if ('exclude_tags' in args) scrapeOptions.exclude_tags = validatedArgs.exclude_tags;
        if ('json_options' in args) scrapeOptions.json_options = validatedArgs.json_options;
        if ('extract_source' in args) scrapeOptions.extract_source = validatedArgs.extract_source;

        // Use SDK's aggregated crawl which handles creation and polling internally
        const pollSeconds: number = (args as any).poll_seconds
            ?? (((args as any).poll_interval_ms ? Math.max(1, Math.round((args as any).poll_interval_ms / 1000)) : 3));
        const timeoutMs: number = (args as any).timeout_ms ?? 60000;

        const aggregated = await (this.client as any).crawl(crawlArgs, pollSeconds, timeoutMs);

        const ret = {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(aggregated, null, 2),
                } as TextContent,
            ],
        };
        logger.debug('Tool anycrawl_crawl completed successfully');
        return ret;
    }

    private async handleCrawlStatus(args: any): Promise<CallToolResult> {
        const validatedArgs = CrawlStatusToolSchema.parse(args);
        const result = await this.client.getCrawlStatus(validatedArgs.job_id);

        const response = {
            job_id: result.job_id,
            status: result.status,
            start_time: result.start_time,
            expires_at: result.expires_at,
            credits_used: result.credits_used,
            total: result.total,
            completed: result.completed,
            failed: result.failed,
        };

        const ret3 = {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(response, null, 2),
                } as TextContent,
            ],
        };
        logger.debug('Tool anycrawl_crawl_status completed successfully');
        return ret3;
    }

    private async handleCrawlResults(args: any): Promise<CallToolResult> {
        const validatedArgs = CrawlResultsToolSchema.parse(args);
        const result = await this.client.getCrawlResults(validatedArgs.job_id, validatedArgs.skip);

        const response = {
            status: result.status,
            total: result.total,
            completed: result.completed,
            creditsUsed: result.creditsUsed,
            next: result.next,
            data: result.data,
        };

        const ret4 = {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(response, null, 2),
                } as TextContent,
            ],
        };
        logger.debug('Tool anycrawl_crawl_results completed successfully');
        return ret4;
    }

    private async handleCancelCrawl(args: any): Promise<CallToolResult> {
        const validatedArgs = CancelCrawlToolSchema.parse(args);
        const result = await this.client.cancelCrawl(validatedArgs.job_id);

        const ret5 = {
            content: [
                {
                    type: 'text',
                    text: `Crawl job cancelled successfully!\nJob ID: ${result.job_id}\nStatus: ${result.status}`,
                } as TextContent,
            ],
        };
        logger.debug('Tool anycrawl_cancel_crawl completed successfully');
        return ret5;
    }

    private async handleSearch(args: any): Promise<CallToolResult> {
        const validatedArgs = SearchToolSchema.parse(args);

        // Top-level search params
        const searchArgs: any = {
            query: validatedArgs.query,
        };
        if ('engine' in args) searchArgs.engine = validatedArgs.engine; // search engine (e.g., google)
        if ('limit' in args) searchArgs.limit = validatedArgs.limit;
        if ('offset' in args) searchArgs.offset = validatedArgs.offset;
        if ('pages' in args) searchArgs.pages = validatedArgs.pages;
        if ('lang' in args) searchArgs.lang = validatedArgs.lang;
        if ('country' in args) searchArgs.country = validatedArgs.country;
        if ('safeSearch' in args) searchArgs.safeSearch = validatedArgs.safeSearch;

        // Build nested scrape_options from SearchScrapeOptions fields
        const scrapeOptions: any = {};
        if ('scrape_engine' in args) scrapeOptions.engine = (validatedArgs as any).scrape_engine;
        if ('proxy' in args) scrapeOptions.proxy = validatedArgs.proxy as any;
        if ('formats' in args) scrapeOptions.formats = validatedArgs.formats as any;
        if ('timeout' in args) scrapeOptions.timeout = validatedArgs.timeout as any;
        if ('wait_for' in args) scrapeOptions.wait_for = validatedArgs.wait_for as any;
        if ('include_tags' in args) scrapeOptions.include_tags = validatedArgs.include_tags as any;
        if ('exclude_tags' in args) scrapeOptions.exclude_tags = validatedArgs.exclude_tags as any;
        if ('json_options' in args) scrapeOptions.json_options = validatedArgs.json_options as any;
        if ('extract_source' in args) scrapeOptions.extract_source = (validatedArgs as any).extract_source;
        if (Object.keys(scrapeOptions).length > 0) {
            searchArgs.scrape_options = scrapeOptions;
        }

        const results = await this.client.search(searchArgs);

        const ret6 = {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(results, null, 2),
                } as TextContent,
            ],
        };
        logger.debug('Tool anycrawl_search completed successfully');
        return ret6;
    }

}
