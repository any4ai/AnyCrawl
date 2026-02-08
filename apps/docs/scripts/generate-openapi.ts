import 'zod-openapi/extend';
import { z } from 'zod';
import { createDocument, extendZodWithOpenApi } from 'zod-openapi';
import { writeFileSync } from 'fs';
import { join } from 'path';

// Import real schemas from API workspace packages
import { searchSchema, baseSchema, jsonOptionsSchema, ALLOWED_ENGINES, EXTRACT_SOURCES, crawlSchema, mapSchema } from '@anycrawl/libs';

// Build request input schema from API baseSchema (avoid transformed schema that lacks .openapi)
// Cast to any to allow .openapi chaining locally. We only need types for the generated document shape.
const scrapeInputSchema: any = (baseSchema as any).pick({
    url: true,
    engine: true,
    proxy: true,
    formats: true,
    timeout: true,
    retry: true,
    wait_for: true,
    wait_until: true,
    wait_for_selector: true,
    only_main_content: true,
    max_age: true,
    store_in_cache: true,
    include_tags: true,
    exclude_tags: true,
    json_options: true,
    extract_source: true,
});

// Ensure the local Zod instance is extended (for response schemas below)
extendZodWithOpenApi(z);

// Local wrapper to safely add OpenAPI metadata even if upstream types are not augmented
const withOpenApi = (schema: any, meta: any) => {
    const s: any = schema as any;
    return typeof s.openapi === 'function' ? s.openapi(meta) : s;
};

// Use API's jsonOptionsSchema and override its inner schema field to a non-recursive placeholder to avoid circular refs
const jsonOptionsSchemaForDocs = (jsonOptionsSchema as any).extend({
    schema: z.record(z.any()).openapi({
        description: 'JSON Schema specification object (free-form JSON). Use standard JSON Schema here.'
    }).optional(),
    user_prompt: withOpenApi((jsonOptionsSchema as any).shape.user_prompt, {
        description: 'The user prompt to be used for extracting structured data'
    }).optional(),
    schema_name: withOpenApi((jsonOptionsSchema as any).shape.schema_name, {
        description: 'The name of the schema to be used for extracting structured data'
    }).optional(),
    schema_description: withOpenApi((jsonOptionsSchema as any).shape.schema_description, {
        description: 'The description of the schema to be used for extracting structured data'
    }).optional(),
}).optional();


// Note: Avoid calling .openapi() directly on imported schemas; use withOpenApi wrapper.

// Request Schemas by extending imported schemas with OpenAPI metadata (no redefinition)
const scrapeSchemaForOpenAPI = withOpenApi(
    (scrapeInputSchema as any).extend({
        url: withOpenApi((scrapeInputSchema as any).shape.url, {
            description: 'The URL to be scraped',
            example: 'https://httpstat.us/200'
        }),
        // Override engine enum to use local zod instance (avoid cross-version enum issues)
        engine: z.enum(ALLOWED_ENGINES as any).openapi({
            description: 'The engine to use',
            example: 'cheerio'
        }),
        proxy: withOpenApi((scrapeInputSchema as any).shape.proxy, {
            description: 'Proxy URL to route the request through (e.g., http://user:pass@host:port)'
        }),
        formats: withOpenApi((scrapeInputSchema as any).shape.formats, {
            description: 'Output formats to return',
            example: ['markdown']
        }),
        timeout: withOpenApi((scrapeInputSchema as any).shape.timeout, {
            description: 'Request timeout in milliseconds',
            example: 60000,
            default: 60000
        }),
        retry: withOpenApi((scrapeInputSchema as any).shape.retry, {
            description: 'Whether to retry on failure',
            example: false,
            default: false
        }),
        wait_for: withOpenApi((scrapeInputSchema as any).shape.wait_for, {
            description: 'Delay before processing (ms)',
            example: 1000
        }),
        wait_until: withOpenApi((scrapeInputSchema as any).shape.wait_until, {
            description: 'Navigation wait condition for browser engines',
            example: 'networkidle'
        }),
        wait_for_selector: withOpenApi((scrapeInputSchema as any).shape.wait_for_selector, {
            description: 'Wait for one or multiple selectors before extraction (browser engines only)'
        }),
        only_main_content: withOpenApi((scrapeInputSchema as any).shape.only_main_content, {
            description: 'Only extract main content, removing headers, footers, navigation, etc.',
            example: true,
            default: true
        }),
        max_age: withOpenApi((scrapeInputSchema as any).shape.max_age, {
            description: 'Cache max age (ms). Use 0 to skip cache reads; omit to use server default.',
            example: 172800000
        }),
        store_in_cache: withOpenApi((scrapeInputSchema as any).shape.store_in_cache, {
            description: 'Whether to write Page Cache for this scrape',
            example: true,
            default: true
        }),
        include_tags: withOpenApi((scrapeInputSchema as any).shape.include_tags, {
            description: 'Only include elements with these CSS selectors',
            example: []
        }),
        exclude_tags: withOpenApi((scrapeInputSchema as any).shape.exclude_tags, {
            description: 'Exclude elements with these CSS selectors',
            example: []
        }),
        // Override to avoid circularly-referenced JSON schema
        json_options: withOpenApi((jsonOptionsSchemaForDocs as any).optional(), {
            description: 'Advanced: JSON extraction options (optional). Leave empty to omit from request.'
        }),
        extract_source: withOpenApi((scrapeInputSchema as any).shape.extract_source, {
            description: 'The source format to use for JSON extraction (html or markdown)',
            example: 'markdown',
            default: 'markdown'
        })
    }),
    { description: 'Request schema for web scraping', example: { url: 'https://example.com', "engine": "cheerio", "formats": ["markdown"] } }
);

// Centralized docs-safe scrape options (without engine) to reuse across endpoints
const scrapeOptionsForOpenAPI: any = (() => {
    const picked: any = (scrapeInputSchema as any).pick({
        proxy: true,
        formats: true,
        timeout: true,
        wait_for: true,
        wait_for_selector: true,
        only_main_content: true,
        max_age: true,
        store_in_cache: true,
        include_tags: true,
        exclude_tags: true,
        json_options: true,
        extract_source: true,
    });

    return withOpenApi(
        (picked as any).extend({
            proxy: withOpenApi((picked as any).shape.proxy, {
                description: 'Proxy URL to route the request through (e.g., http://user:pass@host:port)'
            }),
            formats: withOpenApi((picked as any).shape.formats, {
                description: 'Output formats to return',
                example: ['markdown']
            }),
            timeout: withOpenApi((picked as any).shape.timeout, {
                description: 'Request timeout in milliseconds',
                example: 60000,
                default: 60000
            }),
            wait_for: withOpenApi((picked as any).shape.wait_for, {
                description: 'Delay before processing (ms)',
                example: 1000
            }),
            wait_for_selector: withOpenApi((picked as any).shape.wait_for_selector, {
                description: 'Wait for one or multiple selectors before extraction (browser engines only)'
            }),
            only_main_content: withOpenApi((picked as any).shape.only_main_content, {
                description: 'Only extract main content, removing headers, footers, navigation, etc.',
                example: true,
                default: true
            }),
            max_age: withOpenApi((picked as any).shape.max_age, {
                description: 'Cache max age (ms). Use 0 to skip cache reads; omit to use server default.',
                example: 172800000
            }),
            store_in_cache: withOpenApi((picked as any).shape.store_in_cache, {
                description: 'Whether to write Page Cache for per-URL scrapes',
                example: true,
                default: true
            }),
            include_tags: withOpenApi((picked as any).shape.include_tags, {
                description: 'Only include elements with these CSS selectors',
                example: []
            }),
            exclude_tags: withOpenApi((picked as any).shape.exclude_tags, {
                description: 'Exclude elements with these CSS selectors',
                example: []
            }),
            json_options: withOpenApi((jsonOptionsSchemaForDocs as any).optional(), {
                description: 'Advanced: JSON extraction options (optional). Leave empty to omit from request.'
            }),
            extract_source: z.enum(EXTRACT_SOURCES as any).openapi({
                description: 'The source format to use for JSON extraction (html or markdown)',
                example: 'markdown',
                default: 'markdown'
            })
        }).partial(),
        { description: 'Per-URL scraping options used during enrichment and crawling' }
    );
})();

// Search enrichment scrape options (includes wait_until; omits only_main_content)
const searchScrapeOptionsForOpenAPI: any = (() => {
    const picked: any = (scrapeInputSchema as any).pick({
        proxy: true,
        formats: true,
        timeout: true,
        wait_for: true,
        wait_until: true,
        wait_for_selector: true,
        max_age: true,
        store_in_cache: true,
        include_tags: true,
        exclude_tags: true,
        json_options: true,
        extract_source: true,
    });

    return withOpenApi(
        (picked as any).extend({
            proxy: withOpenApi((picked as any).shape.proxy, {
                description: 'Proxy URL to route the request through (e.g., http://user:pass@host:port)'
            }),
            formats: withOpenApi((picked as any).shape.formats, {
                description: 'Output formats to return',
                example: ['markdown']
            }),
            timeout: withOpenApi((picked as any).shape.timeout, {
                description: 'Request timeout in milliseconds',
                example: 60000,
                default: 60000
            }),
            wait_for: withOpenApi((picked as any).shape.wait_for, {
                description: 'Delay before processing (ms)',
                example: 1000
            }),
            wait_until: withOpenApi((picked as any).shape.wait_until, {
                description: 'Navigation wait condition for browser engines',
                example: 'networkidle'
            }),
            wait_for_selector: withOpenApi((picked as any).shape.wait_for_selector, {
                description: 'Wait for one or multiple selectors before extraction (browser engines only)'
            }),
            max_age: withOpenApi((picked as any).shape.max_age, {
                description: 'Cache max age (ms). Use 0 to skip cache reads; omit to use server default.',
                example: 172800000
            }),
            store_in_cache: withOpenApi((picked as any).shape.store_in_cache, {
                description: 'Whether to write Page Cache for per-URL scrapes',
                example: true,
                default: true
            }),
            include_tags: withOpenApi((picked as any).shape.include_tags, {
                description: 'Only include elements with these CSS selectors',
                example: []
            }),
            exclude_tags: withOpenApi((picked as any).shape.exclude_tags, {
                description: 'Exclude elements with these CSS selectors',
                example: []
            }),
            json_options: withOpenApi((jsonOptionsSchemaForDocs as any).optional(), {
                description: 'Advanced: JSON extraction options (optional). Leave empty to omit from request.'
            }),
            extract_source: z.enum(EXTRACT_SOURCES as any).openapi({
                description: 'The source format to use for JSON extraction (html or markdown)',
                example: 'markdown',
                default: 'markdown'
            })
        }).partial(),
        { description: 'Per-result scraping options used during search enrichment' }
    );
})();

const searchSchemaForOpenAPI = withOpenApi(
    (searchSchema as any).omit({ template_id: true, variables: true }).extend({
        engine: withOpenApi((searchSchema as any).shape.engine, {
            description: 'The search engine to be used',
            example: 'google'
        }),
        query: withOpenApi((searchSchema as any).shape.query, {
            description: 'The search query string',
            example: 'OpenAI ChatGPT'
        }),
        limit: withOpenApi((searchSchema as any).shape.limit, {
            description: 'Maximum number of results per page. If scrape_options is provided, this also acts as a global cap on the number of result URLs to scrape across all pages.',
            example: 10,
            default: 10
        }),
        offset: withOpenApi((searchSchema as any).shape.offset, {
            description: 'Number of results to skip',
            example: 0,
            default: 0
        }),
        pages: withOpenApi((searchSchema as any).shape.pages, {
            description: 'Number of pages to search',
            example: 1,
            default: 1
        }),
        lang: withOpenApi((searchSchema as any).shape.lang, {
            description: 'Language locale for search results',
            example: 'en'
        }),
        country: withOpenApi((searchSchema as any).shape.country, {
            description: 'Country locale for search results',
            example: 'US'
        }),
        safe_search: withOpenApi((searchSchema as any).shape.safe_search, {
            description: 'Safe search filter level for Google. 0: off, 1: medium, 2: high, null: default',
            example: 1,
            enum: [0, 1, 2],
            nullable: true
        }),
        // Reuse crawl scrape options and add engine for search enrichment (no duplication)
        scrape_options: withOpenApi(
            (searchScrapeOptionsForOpenAPI as any).extend({
                engine: z.enum(ALLOWED_ENGINES as any).openapi({
                    description: 'Scraping engine used to enrich each search result URL',
                    example: 'cheerio'
                })
            }),
            {
                description:
                    'Optional scraping options. If provided, the service scrapes result URLs (capped by limit across all pages) and merges outputs (e.g., html, markdown, metadata) into each item.'
            }
        )
    }),
    { description: 'Request schema for web search', example: { engine: 'google', query: 'OpenAI ChatGPT', limit: 10, offset: 0, pages: 1 } }
);

const mapSchemaForOpenAPI = withOpenApi(
    (mapSchema as any).extend({
        url: withOpenApi((mapSchema as any).shape.url, {
            description: 'The URL to map',
            example: 'https://example.com'
        }),
        limit: withOpenApi((mapSchema as any).shape.limit, {
            description: 'Maximum number of URLs to return',
            example: 5000,
            default: 5000
        }),
        include_subdomains: withOpenApi((mapSchema as any).shape.include_subdomains, {
            description: 'Include subdomain URLs',
            example: false,
            default: false
        }),
        ignore_sitemap: withOpenApi((mapSchema as any).shape.ignore_sitemap, {
            description: 'Skip sitemap parsing',
            example: false,
            default: false
        }),
        max_age: withOpenApi((mapSchema as any).shape.max_age, {
            description: 'Cache max age (ms). Use 0 to skip cache reads; omit to use server default.',
            example: 172800000
        }),
        use_index: withOpenApi((mapSchema as any).shape.use_index, {
            description: 'Whether to use Page Cache index for URL discovery',
            example: true,
            default: true
        })
    }),
    { description: 'Request schema for mapping site URLs', example: { url: 'https://example.com', limit: 5000 } }
);

const mapLinkSchemaForOpenAPI = z.object({
    url: z.string().url().openapi({
        description: 'Discovered URL',
        example: 'https://example.com/about'
    }),
    title: z.string().openapi({
        description: 'Optional title for the URL',
        example: 'About Us'
    }).optional(),
    description: z.string().openapi({
        description: 'Optional description for the URL',
        example: 'Company overview and mission'
    }).optional(),
});

const mapSuccessResponseSchema = z.object({
    success: z.literal(true).openapi({
        description: 'Indicates the map request was successful'
    }),
    data: z.array(mapLinkSchemaForOpenAPI).openapi({
        description: 'Array of discovered URLs',
        example: [
            {
                url: 'https://example.com/',
                title: 'Home',
                description: 'Example homepage'
            }
        ]
    })
}).openapi({
    description: 'Successful map response format containing discovered URLs'
});

// scrapeOptionsForOpenAPI defined above

// Use crawl schema from API and peel off the effects layer to get the input schema,
// then override only json_options to avoid circular refs in docs
const crawlInputFromApi: any = (crawlSchema as any)?._def?.schema ?? (crawlSchema as any)?._def?.innerType ?? crawlSchema;

// Reuse the library's crawl input schema and omit template-only fields for normal mode docs
const crawlInputSchema: any = (crawlInputFromApi as any)
    .omit({ template_id: true, variables: true })
    .extend({
        // Override json_options to docs-safe version
        json_options: jsonOptionsSchemaForDocs.optional(),
        // Nested scrape options (partial of scrape input sans retry)
        scrape_options: scrapeOptionsForOpenAPI.optional(),
    });

const crawlSchemaForOpenAPI = withOpenApi(
    (crawlInputSchema as any).extend({
        url: withOpenApi((crawlInputSchema as any).shape.url, {
            description: 'Seed URL to start crawling',
            example: 'https://anycrawl.dev'
        }),
        // Override engine enum to use local zod instance (avoid cross-version enum issues)
        engine: z.enum(ALLOWED_ENGINES as any).openapi({
            description: 'The scraping engine used for each crawled page',
            example: 'cheerio'
        }),
        exclude_paths: withOpenApi((crawlInputSchema as any).shape.exclude_paths, {
            description: 'Glob patterns or path prefixes to exclude from crawling',
            example: ['/blog/*', '/privacy']
        }),
        include_paths: withOpenApi((crawlInputSchema as any).shape.include_paths, {
            description: 'Glob patterns or path prefixes to include (applied after exclusion rules)'
        }),
        max_depth: withOpenApi((crawlInputSchema as any).shape.max_depth, {
            description: 'Maximum crawl depth from the seed URL',
            example: 5,
            default: 10
        }),
        strategy: withOpenApi((crawlInputSchema as any).shape.strategy, {
            description: 'Crawl scope strategy',
            example: 'same-domain',
            enum: ['all', 'same-domain', 'same-hostname', 'same-origin'],
            default: 'same-domain'
        }),
        limit: withOpenApi((crawlInputSchema as any).shape.limit, {
            description: 'Maximum number of pages to crawl',
            example: 100,
            default: 100
        }),
        scrape_options: withOpenApi((crawlInputSchema as any).shape.scrape_options, {
            description: 'Per-page scraping options applied during crawling'
        })
    }),
    { description: 'Request schema for site crawling', example: { url: 'https://anycrawl.dev', engine: 'cheerio' } }
);

// Success Response Schemas
const scrapeSuccessResponseSchema = z.object({
    success: z.literal(true).openapi({
        description: 'Indicates the scraping request was successful'
    }),
    data: z.union([
        z.object({
            url: z.string().url().openapi({
                description: 'The URL that was scraped',
                example: 'https://httpstat.us/200'
            }),
            status: z.literal('completed').openapi({
                description: 'The status of the scraping job when successful',
                example: 'completed'
            }),
            jobId: z.string().uuid().openapi({
                description: 'Unique identifier for the scraping job',
                example: '7a2e165d-8f81-4be6-9ef7-23222330a396'
            }),
            title: z.string().openapi({
                description: 'The title of the scraped page',
                example: ''
            }),
            html: z.string().openapi({
                description: 'The HTML content of the scraped page',
                example: '200 OK'
            }),
            markdown: z.string().openapi({
                description: 'The markdown content of the scraped page',
                example: '200 OK'
            }),
            metadata: z.array(z.any()).openapi({
                description: 'Additional metadata extracted from the page',
                example: []
            }),
            cachedAt: z.string().datetime().openapi({
                description: 'When the cached content was stored (cache hit only)',
                example: '2026-02-08T12:34:56.000Z'
            }).optional(),
            maxAge: z.number().openapi({
                description: 'Cache max age used for the read (ms, cache hit only)',
                example: 172800000
            }).optional(),
            timestamp: z.string().datetime().openapi({
                description: 'Timestamp when the scraping was completed',
                example: '2025-05-25T07:56:44.162Z'
            })
        }).openapi({
            description: 'Successful scraping result data'
        }),
        z.object({
            url: z.string().url().openapi({
                description: 'The URL that was attempted to be scraped',
                example: 'https://httpstat.us/403'
            }),
            status: z.literal('failed').openapi({
                description: 'The status of the scraping job when failed',
                example: 'failed'
            }),
            error: z.string().openapi({
                description: 'Error message describing why the scraping failed',
                example: 'Request blocked - received 403 status code.'
            })
        }).openapi({
            description: 'Failed scraping result data'
        })
    ]).openapi({
        description: 'Scraping result data - either successful with full content or failed with error message'
    })
}).openapi({
    description: 'Scraping response format (HTTP 200) - can contain either successful or failed scraping results'
});

const searchSuccessResponseSchema = z.object({
    success: z.literal(true).openapi({
        description: 'Indicates the search request was successful'
    }),
    data: z.array(z.union([
        z.object({
            title: z.string().openapi({
                description: 'The title of the search result',
                example: 'AlsoAsked: People Also Ask keyword research tool'
            }),
            url: z.string().url().openapi({
                description: 'The URL of the search result',
                example: 'https://alsoasked.com/'
            }),
            description: z.string().openapi({
                description: 'The description/snippet of the search result',
                example: 'Find the questions people also ask. Enter a question, brand or search query. e.g. \'keyword research\'.'
            }),
            source: z.string().openapi({
                description: 'The source of the search result',
                example: 'Google Search Result'
            })
        }).openapi({
            description: 'Search result with URL and description'
        }),
        z.object({
            title: z.string().openapi({
                description: 'The title of the search suggestion',
                example: 'Keyword tool'
            }),
            source: z.string().openapi({
                description: 'The source of the search suggestion',
                example: 'Google Suggestions'
            })
        }).openapi({
            description: 'Search suggestion without URL'
        })
    ])).openapi({
        description: 'Array of search results and suggestions - can be empty if no results found. When scrape_options is used, additional enriched fields (e.g., html, markdown, metadata, status, jobId) may be present on each result.',
        example: [
            {
                "title": "The Investment Case for Digital Infrastructure",
                "url": "https://www.patrizia.ag/fileadmin/user_upload/The_Investment_Case_for_Digital_Infrastructure.pdf",
                "description": "It took just five days for ChatGPT to reach one million users and just two months to reach 100 million users, the fastest of any social media platform or app in ...48 pages",
                "source": "Google Search Result"
            }
        ]
    })
}).openapi({
    description: 'Successful search response format containing an array of search results and suggestions (may be empty)'
});

const errorResponseSchema = z.object({
    success: z.literal(false).openapi({
        description: 'Indicates the request failed'
    }),
    error: z.string().openapi({
        description: 'Error message',
        example: 'Validation error'
    }),
    details: z.object({
        issues: z.array(z.object({
            field: z.string().openapi({
                description: 'The field that caused the error',
                example: 'engine'
            }),
            message: z.string().openapi({
                description: 'Error message for the field',
                example: "Invalid enum value. Expected 'playwright' | 'cheerio' | 'puppeteer', received 'cheeri1o'"
            }),
            code: z.string().openapi({
                description: 'Error code',
                example: 'invalid_enum_value'
            })
        })).openapi({
            description: 'Array of validation issues'
        }),
        messages: z.array(z.string()).openapi({
            description: 'Array of validation error messages',
            example: ["Invalid enum value. Expected 'playwright' | 'cheerio' | 'puppeteer', received 'cheeri1o'"]
        })
    }).openapi({
        description: 'Validation error details'
    })
}).openapi({
    description: 'Standard error response format for validation errors'
});

const InsufficientCreditsResponseSchema = z.object({
    success: z.literal(false).openapi({
        description: 'Indicates the request failed due to insufficient credits'
    }),
    error: z.string().openapi({
        description: 'Error message',
        example: 'Insufficient credits'
    }),
    current_credits: z.number().openapi({
        description: 'Current credit balance of the user',
        example: -2
    })
}).openapi({
    description: 'Payment required response format with credit information'
});

const unauthorizedResponseSchema = z.object({
    success: z.literal(false).openapi({
        description: 'Indicates the request failed due to authentication issues'
    }),
    error: z.string().openapi({
        description: 'Authentication error message',
        example: 'Invalid API key',
        examples: ['Invalid API key', 'No authorization header provided']
    })
}).openapi({
    description: 'Unauthorized response format for authentication errors'
});

const internalServerErrorResponseSchema = z.object({
    success: z.literal(false).openapi({
        description: 'Indicates the request failed due to server error'
    }),
    error: z.string().openapi({
        description: 'Server error message',
        example: 'Internal server error'
    }),
    message: z.string().openapi({
        description: 'Detailed error message describing what went wrong',
        example: 'Job 0ae56ed9-d9a9-4998-aea9-2ff5b51b2e4e timed out after 30000 seconds'
    })
}).openapi({
    description: 'Internal server error response format'
});

const crawlStartResponseSchema = z.object({
    success: z.literal(true).openapi({
        description: 'Indicates the crawl job was accepted and queued'
    }),
    data: z.object({
        job_id: z.string().uuid().openapi({
            description: 'Crawl job identifier',
            example: '7a2e165d-8f81-4be6-9ef7-23222330a396'
        }),
        status: z.literal('created').openapi({
            description: 'Initial job status',
            example: 'created'
        }),
        message: z.string().openapi({
            description: 'Human-readable confirmation message',
            example: 'Crawl job has been queued for processing'
        })
    })
}).openapi({ description: 'Crawl job creation response (HTTP 200)' });

const crawlStatusResponseSchema = z.object({
    success: z.literal(true),
    message: z.string().openapi({
        description: 'Status message',
        example: 'Job status retrieved successfully'
    }),
    data: z.object({
        job_id: z.string().uuid(),
        status: z.enum(['pending', 'completed', 'failed', 'cancelled']).openapi({ example: 'pending' }),
        start_time: z.string().datetime().openapi({ example: '2025-05-25T07:56:44.162Z' }),
        expires_at: z.string().datetime().openapi({ example: '2025-05-26T07:56:44.162Z' }),
        credits_used: z.number().openapi({ example: 0 }),
        total: z.number().openapi({ example: 120 }),
        completed: z.number().openapi({ example: 30 }),
        failed: z.number().openapi({ example: 2 })
    })
}).openapi({ description: 'Crawl job status response (HTTP 200)' });

const crawlResultsResponseSchema = z.object({
    success: z.literal(true),
    status: z.enum(['pending', 'completed', 'failed', 'cancelled']).openapi({ example: 'pending' }),
    total: z.number().openapi({ example: 120 }),
    completed: z.number().openapi({ example: 30 }),
    creditsUsed: z.number().openapi({ example: 12 }),
    next: z.string().url().nullable().optional().openapi({
        description: 'Next page URL if more results are available',
        example: 'https://api.anycrawl.dev/v1/crawl/7a2e165d-8f81-4be6-9ef7-23222330a396?skip=100'
    }),
    data: z.array(z.any()).openapi({
        description: 'Array of per-page scraping results produced by the crawl'
    })
}).openapi({ description: 'Crawl job results (paginated) response (HTTP 200)' });

const crawlCancelResponseSchema = z.object({
    success: z.literal(true),
    message: z.string().openapi({ example: 'Job cancelled successfully' }),
    data: z.object({
        job_id: z.string().uuid(),
        status: z.literal('cancelled')
    })
}).openapi({ description: 'Crawl job cancellation response (HTTP 200)' });

// Generate OpenAPI document
const document = createDocument({
    openapi: '3.1.0',
    info: {
        title: 'AnyCrawl API',
        version: '0.0.1',
        description: 'AnyCrawl 🚀: A Node.js/TypeScript crawler that turns websites into LLM-ready data and extracts structured SERP results from Google/Bing/Baidu/etc. Native multi-threading for bulk processing.',
        contact: {
            name: 'AnyCrawl Support',
            url: 'https://github.com/anycrawl/anycrawl',
            email: 'support@anycrawl.dev'
        },
        license: {
            name: 'MIT',
            url: 'https://opensource.org/licenses/MIT'
        },
        termsOfService: 'https://anycrawl.dev/terms'
    },
    servers: [
        {
            url: 'https://api.anycrawl.dev',
            description: 'Production server'
        },
        {
            url: 'http://localhost:8080',
            description: 'Development server (localhost)'
        }
    ],
    paths: {
        '/health': {
            get: {
                summary: 'Health status',
                description: 'Get server health status',
                tags: ['Health'],
                responses: {
                    '200': {
                        description: 'Server health status',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: {
                                            type: 'string',
                                            example: 'ok'
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/v1/crawl': {
            post: {
                summary: 'Create Crawl task',
                description: 'Start a site crawl job. The job runs asynchronously and returns a job_id for polling.',
                tags: ['Crawl'],
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: crawlSchemaForOpenAPI
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'Crawl job created',
                        content: {
                            'application/json': {
                                schema: crawlStartResponseSchema
                            }
                        }
                    },
                    '400': {
                        description: 'Bad request - validation error',
                        content: {
                            'application/json': {
                                schema: errorResponseSchema
                            }
                        }
                    },
                    '401': {
                        description: 'Unauthorized - missing or invalid authentication',
                        content: {
                            'application/json': {
                                schema: unauthorizedResponseSchema
                            }
                        }
                    },
                    '402': {
                        description: 'Payment required - subscription or credits needed',
                        content: {
                            'application/json': {
                                schema: InsufficientCreditsResponseSchema
                            }
                        }
                    },
                    '500': {
                        description: 'Internal server error',
                        content: {
                            'application/json': {
                                schema: internalServerErrorResponseSchema
                            }
                        }
                    }
                }
            }
        },
        '/v1/crawl/{jobId}/status': {
            get: {
                summary: 'Check Crawl status',
                description: 'Get the current status of a crawl job',
                tags: ['Crawl'],
                security: [{ bearerAuth: [] }],
                parameters: [
                    {
                        name: 'jobId',
                        in: 'path',
                        required: true,
                        schema: { type: 'string', format: 'uuid' },
                        description: 'The crawl job ID'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Crawl status retrieved',
                        content: {
                            'application/json': {
                                schema: crawlStatusResponseSchema
                            }
                        }
                    },
                    '400': {
                        description: 'Bad request - invalid job id',
                        content: {
                            'application/json': {
                                schema: errorResponseSchema
                            }
                        }
                    },
                    '401': {
                        description: 'Unauthorized - missing or invalid authentication',
                        content: {
                            'application/json': {
                                schema: unauthorizedResponseSchema
                            }
                        }
                    },
                    '500': {
                        description: 'Internal server error',
                        content: {
                            'application/json': {
                                schema: internalServerErrorResponseSchema
                            }
                        }
                    }
                }
            }
        },
        '/v1/crawl/{jobId}': {
            get: {
                summary: 'Get Crawl results',
                description: 'Get crawl results (paginated via skip query param).',
                tags: ['Crawl'],
                security: [{ bearerAuth: [] }],
                parameters: [
                    {
                        name: 'jobId',
                        in: 'path',
                        required: true,
                        schema: { type: 'string', format: 'uuid' },
                        description: 'The crawl job ID'
                    },
                    {
                        name: 'skip',
                        in: 'query',
                        required: false,
                        schema: { type: 'integer', minimum: 0 },
                        description: 'Number of results to skip (page offset)'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Crawl results page',
                        content: {
                            'application/json': {
                                schema: crawlResultsResponseSchema
                            }
                        }
                    },
                    '400': {
                        description: 'Bad request - invalid job id',
                        content: {
                            'application/json': {
                                schema: errorResponseSchema
                            }
                        }
                    },
                    '401': {
                        description: 'Unauthorized - missing or invalid authentication',
                        content: {
                            'application/json': {
                                schema: unauthorizedResponseSchema
                            }
                        }
                    },
                    '500': {
                        description: 'Internal server error',
                        content: {
                            'application/json': {
                                schema: internalServerErrorResponseSchema
                            }
                        }
                    }
                }
            },
            delete: {
                summary: 'Cancel crawl',
                description: 'Cancel a pending crawl job',
                tags: ['Crawl'],
                security: [{ bearerAuth: [] }],
                parameters: [
                    {
                        name: 'jobId',
                        in: 'path',
                        required: true,
                        schema: { type: 'string', format: 'uuid' },
                        description: 'The crawl job ID'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Crawl cancelled',
                        content: {
                            'application/json': {
                                schema: crawlCancelResponseSchema
                            }
                        }
                    },
                    '400': {
                        description: 'Bad request - invalid job id',
                        content: {
                            'application/json': {
                                schema: errorResponseSchema
                            }
                        }
                    },
                    '401': {
                        description: 'Unauthorized - missing or invalid authentication',
                        content: {
                            'application/json': {
                                schema: unauthorizedResponseSchema
                            }
                        }
                    },
                    '500': {
                        description: 'Internal server error',
                        content: {
                            'application/json': {
                                schema: internalServerErrorResponseSchema
                            }
                        }
                    }
                }
            }
        },
        '/v1/scrape': {
            post: {
                summary: 'Scrape',
                description: 'AnyCrawl scrapes a URL, turns it into structured data and LLM-ready data. It supports multiple engines, including Cheerio, Playwright, Puppeteer, and more. It also supports multiple output formats, including HTML, Markdown, JSON, and more.',
                tags: ['Scraping'],
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: scrapeSchemaForOpenAPI
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'Scraping successful',
                        content: {
                            'application/json': {
                                schema: scrapeSuccessResponseSchema
                            }
                        }
                    },
                    '400': {
                        description: 'Bad request - validation error',
                        content: {
                            'application/json': {
                                schema: errorResponseSchema
                            }
                        }
                    },
                    '401': {
                        description: 'Unauthorized - missing or invalid authentication',
                        content: {
                            'application/json': {
                                schema: unauthorizedResponseSchema
                            }
                        }
                    },
                    '402': {
                        description: 'Payment required - subscription or credits needed',
                        content: {
                            'application/json': {
                                schema: InsufficientCreditsResponseSchema
                            }
                        }
                    },
                    '500': {
                        description: 'Internal server error',
                        content: {
                            'application/json': {
                                schema: internalServerErrorResponseSchema
                            }
                        }
                    }
                }
            }
        },
        '/v1/search': {
            post: {
                summary: 'SERP',
                description: 'Search the web using specified search engine',
                tags: ['Search'],
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: searchSchemaForOpenAPI
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'Search successful',
                        content: {
                            'application/json': {
                                schema: searchSuccessResponseSchema
                            }
                        }
                    },
                    '400': {
                        description: 'Bad request - validation error',
                        content: {
                            'application/json': {
                                schema: errorResponseSchema
                            }
                        }
                    },
                    '401': {
                        description: 'Unauthorized - missing or invalid authentication',
                        content: {
                            'application/json': {
                                schema: unauthorizedResponseSchema
                            }
                        }
                    },
                    '402': {
                        description: 'Payment required - subscription or credits needed',
                        content: {
                            'application/json': {
                                schema: InsufficientCreditsResponseSchema
                            }
                        }
                    },
                    '500': {
                        description: 'Internal server error',
                        content: {
                            'application/json': {
                                schema: internalServerErrorResponseSchema
                            }
                        }
                    }
                }
            }
        },
        '/v1/map': {
            post: {
                summary: 'Map',
                description: 'Discover URLs for a site using sitemap, search, and page links',
                tags: ['Map'],
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: mapSchemaForOpenAPI
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'Map successful',
                        content: {
                            'application/json': {
                                schema: mapSuccessResponseSchema
                            }
                        }
                    },
                    '400': {
                        description: 'Bad request - validation error',
                        content: {
                            'application/json': {
                                schema: errorResponseSchema
                            }
                        }
                    },
                    '401': {
                        description: 'Unauthorized - missing or invalid authentication',
                        content: {
                            'application/json': {
                                schema: unauthorizedResponseSchema
                            }
                        }
                    },
                    '402': {
                        description: 'Payment required - subscription or credits needed',
                        content: {
                            'application/json': {
                                schema: InsufficientCreditsResponseSchema
                            }
                        }
                    },
                    '500': {
                        description: 'Internal server error',
                        content: {
                            'application/json': {
                                schema: internalServerErrorResponseSchema
                            }
                        }
                    }
                }
            }
        }
    },
    components: {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                description: 'JWT token for API authentication'
            }
        }
    },
    tags: [
        {
            name: 'Health',
            description: 'Health check endpoints'
        },
        {
            name: 'Crawl',
            description: 'Crawl a site and aggregate per-page scraping outputs'
        },
        {
            name: 'Scraping',
            description: 'Turn a URL into structured data and LLM-ready data'
        },
        {
            name: 'Search',
            description: 'SERP, search engine results page'
        },
        {
            name: 'Map',
            description: 'Discover URLs for a site (sitemap, search, and page links)'
        }
    ]
});

// Write generated OpenAPI document to file
const outputPath = join(process.cwd(), 'openapi.json');
const templateOutputPath = join(process.cwd(), 'openapi.template.json');

try {
    writeFileSync(outputPath, JSON.stringify(document, null, 2));

    // Build template-only OpenAPI by cloning and overriding request schemas to template mode
    const templateDoc: any = JSON.parse(JSON.stringify(document));
    const ensure = (p: string, method: 'post') => (templateDoc.paths as any)?.[p]?.[method]?.requestBody?.content?.['application/json'];

    // Scrape and Crawl template schema: template_id + variables + url (optional)
    const makeScrapeOrCrawlTemplateSchema = (desc: string) => ({
        type: 'object',
        additionalProperties: false,
        required: ['template_id'],
        properties: {
            template_id: { type: 'string', description: 'Template ID to use' },
            variables: { type: 'object', additionalProperties: {}, description: 'Template variables' },
            url: { type: 'string', format: 'uri', description: 'Optional URL when using template' },
        },
        description: desc,
    });

    // Search template schema: template_id + variables + query (optional)
    const makeSearchTemplateSchema = (desc: string) => ({
        type: 'object',
        additionalProperties: false,
        required: ['template_id'],
        properties: {
            template_id: { type: 'string', description: 'Template ID to use' },
            variables: { type: 'object', additionalProperties: {}, description: 'Template variables' },
            query: { type: 'string', description: 'Optional search query when using template' },
        },
        description: desc,
    });

    const s = ensure('/v1/scrape', 'post'); if (s) s.schema = makeScrapeOrCrawlTemplateSchema('Template scrape mode');
    const c = ensure('/v1/crawl', 'post'); if (c) c.schema = makeScrapeOrCrawlTemplateSchema('Template crawl mode');
    const q = ensure('/v1/search', 'post'); if (q) q.schema = makeSearchTemplateSchema('Template search mode');

    writeFileSync(templateOutputPath, JSON.stringify(templateDoc, null, 2));

    console.log('🎉 OpenAPI specification generated successfully!');
    console.log(`📁 File location: ${outputPath}`);
    console.log(`📖 API: ${document.info.title} v${document.info.version}`);
    console.log(`🛣️  Endpoints: ${Object.keys(document.paths || {}).length}`);
    console.log(`📋 Schemas: ${Object.keys(document.components?.schemas || {}).length}`);
    console.log(`🔄 Response Types: ${Object.keys(document.components?.responses || {}).length}`);
    console.log(`🏷️  Tags: ${document.tags?.length || 0}`);

    // Validate document structure
    const pathCount = Object.keys(document.paths || {}).length;
    const schemaCount = Object.keys(document.components?.schemas || {}).length;
    const responseCount = Object.keys(document.components?.responses || {}).length;

    if (pathCount === 0) {
        console.warn('⚠️  Warning: No paths defined in the document');
    }

    if (schemaCount === 0) {
        console.warn('⚠️  Warning: No schemas defined in the document');
    }

    console.log('✨ Document generation completed without errors');

} catch (error) {
    console.error('❌ Error writing OpenAPI specification:');
    console.error(error);
    process.exit(1);
} 
