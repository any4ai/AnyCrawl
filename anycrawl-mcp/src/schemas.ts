import { z } from 'zod';

// Engine types
export const EngineSchema = z.enum(['auto', 'playwright', 'cheerio', 'puppeteer']);
export type Engine = z.infer<typeof EngineSchema>;

// Format types
export const FormatSchema = z.enum([
  'markdown',
  'html',
  'text',
  'screenshot',
  'screenshot@fullPage',
  'rawHtml',
  'json',
]);
export type Format = z.infer<typeof FormatSchema>;

// Extract source types
export const ExtractSourceSchema = z.enum(['html', 'markdown']);
export type ExtractSource = z.infer<typeof ExtractSourceSchema>;

// JSON options schema
export const JsonOptionsSchema = z.object({
  schema: z.any().optional(),
  user_prompt: z.string().optional(),
  schema_name: z.string().optional(),
  schema_description: z.string().optional(),
});

// Base scrape options schema (no engine)
export const ScrapeOptionsBaseSchema = z.object({
  proxy: z.string().url().optional(),
  formats: z.array(FormatSchema).default(['markdown']),
  timeout: z.number().min(1000).max(600000).default(300000),
  wait_for: z.number().min(1).max(60000).optional(),
  include_tags: z.array(z.string()).optional(),
  exclude_tags: z.array(z.string()).optional(),
  json_options: JsonOptionsSchema.optional(),
  extract_source: ExtractSourceSchema.default('markdown').optional(),
});

// Search-specific scrape options (engine optional at top-level as scrape_engine for MCP compatibility)
export const SearchScrapeOptionsSchema = ScrapeOptionsBaseSchema.extend({
  scrape_engine: EngineSchema.optional(),
});
export type SearchScrapeOptions = z.infer<typeof SearchScrapeOptionsSchema>;

export const ScrapeOptionsSchema = ScrapeOptionsBaseSchema.extend({
  engine: EngineSchema,
});

export type ScrapeOptions = z.infer<typeof ScrapeOptionsSchema>;

export const CrawlScrapeOptionsSchema = ScrapeOptionsBaseSchema;

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  details?: any;
}

export interface CrawlJobResponse {
  job_id: string;
  status: 'created' | 'pending' | 'completed' | 'failed' | 'cancelled';
  message: string;
}

export interface CrawlStatusResponse {
  job_id: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  start_time: string;
  expires_at: string;
  credits_used: number;
  total: number;
  completed: number;
  failed: number;
}

export interface CrawlResultsResponse {
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  total: number;
  completed: number;
  creditsUsed: number;
  next?: string;
  data: any[];
}

export interface ScrapeResult {
  url: string;
  status: 'completed' | 'failed';
  jobId?: string;
  title?: string;
  html?: string;
  markdown?: string;
  metadata?: any[];
  timestamp?: string;
  error?: string;
}

export interface SearchResult {
  title: string;
  url?: string;
  description?: string;
  source: string;
}

// MCP Tool schemas
export const ScrapeToolSchema = ScrapeOptionsSchema.extend({
  url: z.string().url(),
  engine: EngineSchema.default('auto'),
  retry: z.boolean().default(false),
  proxy: z.string().url().optional(),
});

export const CrawlToolSchema = ScrapeOptionsBaseSchema.extend({
  url: z.string().url(),
  engine: EngineSchema.default('auto'),
  retry: z.boolean().default(false),
  exclude_paths: z.array(z.string()).optional(),
  include_paths: z.array(z.string()).optional(),
  max_depth: z.number().min(1).max(50).default(10),
  strategy: z.enum(['all', 'same-domain', 'same-hostname', 'same-origin']).default('same-domain'),
  limit: z.number().min(1).max(50000).default(100),
  // Optional waiting options to aggregate results via SDK client.crawl
  poll_seconds: z.number().min(1).max(60).default(3).optional(),
  poll_interval_ms: z.number().min(100).max(60000).default(3000).optional(),
  timeout_ms: z.number().min(1000).max(600000).default(60000).optional(),
  // Optional nested scrape options to pass through during crawl (no defaults)
  scrape_options: z
    .object({
      proxy: z.string().url().optional(),
      formats: z.array(FormatSchema).optional(),
      timeout: z.number().min(1000).max(600000).optional(),
      wait_for: z.number().min(1).max(60000).optional(),
      include_tags: z.array(z.string()).optional(),
      exclude_tags: z.array(z.string()).optional(),
      json_options: JsonOptionsSchema.optional(),
      extract_source: ExtractSourceSchema.optional(),
      engine: EngineSchema.optional(),
    })
    .optional(),
});

export const SearchToolSchema = SearchScrapeOptionsSchema.extend({
  query: z.string(),
  engine: z.enum(['google']).default('google'),
  limit: z.number().min(1).max(100).default(5),
  offset: z.number().min(0).default(0),
  pages: z.number().min(1).max(20).optional(),
  lang: z.string().optional(),
  country: z.string().optional(),
  safeSearch: z.number().min(0).max(2).nullable().optional(),
  // Optional nested scrape options for MCP compatibility
  scrape_options: z
    .object({
      engine: EngineSchema.optional(),
      proxy: z.string().url().optional(),
      formats: z.array(FormatSchema).optional(),
      timeout: z.number().min(1000).max(600000).optional(),
      wait_for: z.number().min(1).max(60000).optional(),
      include_tags: z.array(z.string()).optional(),
      exclude_tags: z.array(z.string()).optional(),
      json_options: JsonOptionsSchema.optional(),
      extract_source: ExtractSourceSchema.optional(),
    })
    .optional(),
});

export const CrawlStatusToolSchema = z.object({
  job_id: z.string(),
});

export const CrawlResultsToolSchema = z.object({
  job_id: z.string(),
  skip: z.number().min(0).default(0),
});

export const CancelCrawlToolSchema = z.object({
  job_id: z.string(),
});
