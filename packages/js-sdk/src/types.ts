export type ApiResponse<T> = { success: true; data: T } | { success: false; error: string; message?: string; data?: any };

export type ExtractSource = 'html' | 'markdown';
export type Engine = 'playwright' | 'cheerio' | 'puppeteer';
export type ScrapeFormat = 'markdown' | 'html' | 'text' | 'screenshot' | 'screenshot@fullPage' | 'rawHtml' | 'json';

// Project-aligned JSON schema (@anycrawl/libs: jsonSchemaType)
export type JSONSchema = {
    type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
    properties?: Record<string, JSONSchema>;
    required?: string[];
    items?: JSONSchema | JSONSchema[];
    description?: string;
};

export type JsonOptions = {
    schema?: JSONSchema;
    user_prompt?: string;
    schema_name?: string;
    schema_description?: string;
};

export type ScrapeOptionsInput = {
    proxy?: string;
    formats?: ScrapeFormat[];
    timeout?: number;
    retry?: boolean;
    wait_for?: number;
    wait_until?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    include_tags?: string[];
    exclude_tags?: string[];
    json_options?: JsonOptions;
    extract_source?: ExtractSource;
};

export type ScrapeRequest = {
    url: string;
    engine: Engine;
} & ScrapeOptionsInput;

export type ScrapeResultSuccess = {
    url: string;
    status: 'completed';
    jobId: string;
    title: string;
    html: string;
    markdown: string;
    metadata: any[];
    timestamp: string;
    screenshot?: string;
    'screenshot@fullPage'?: string;
};
export type ScrapeResultFailed = {
    url: string;
    status: 'failed';
    error: string;
};
export type ScrapeResult = ScrapeResultSuccess | ScrapeResultFailed;

export type CrawlOptions = {
    retry?: boolean;
    exclude_paths?: string[];
    include_paths?: string[];
    max_depth?: number;
    strategy?: 'all' | 'same-domain' | 'same-hostname' | 'same-origin';
    limit?: number;
    scrape_options?: Omit<ScrapeOptionsInput, 'retry'>;
};

export type CrawlRequest = {
    url: string;
    engine: Engine;
} & CrawlOptions; // scrape options must be nested under scrape_options

export type CrawlJobResponse = {
    job_id: string;
    status: 'created';
    message: string;
};

export type CrawlStatus = 'pending' | 'completed' | 'failed' | 'cancelled';
export type CrawlStatusResponse = {
    job_id: string;
    status: CrawlStatus;
    start_time: string;
    expires_at: string;
    credits_used: number;
    total: number;
    completed: number;
    failed: number;
};

export type CrawlResultsResponse = {
    success: true;
    status: CrawlStatus;
    total: number;
    completed: number;
    creditsUsed: number;
    next?: string | null;
    data: any[];
};

export type SearchRequest = {
    engine?: 'google';
    query: string;
    limit?: number;
    offset?: number;
    pages?: number;
    lang?: any;
    country?: any;
    scrape_options?: (Omit<ScrapeOptionsInput, 'retry'> & { engine: Engine });
    safe_search?: number | null;
};

export type SearchResult = {
    title: string;
    url?: string;
    description?: string;
    source: string;
} & Partial<ScrapeResultSuccess>;

export type CrawlAndWaitResult = {
    job_id: string;
    status: CrawlStatus;
    total: number;
    completed: number;
    creditsUsed: number;
    data: any[];
};

