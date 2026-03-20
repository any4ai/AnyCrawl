export type ApiResponse<T> = { success: true; data: T } | { success: false; error: string; message?: string; data?: any };

export type ExtractSource = 'html' | 'markdown';
export type Engine = 'auto' | 'playwright' | 'cheerio' | 'puppeteer';
export type ScrapeFormat = 'markdown' | 'html' | 'text' | 'screenshot' | 'screenshot@fullPage' | 'rawHtml' | 'json' | 'summary' | 'links';

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

export type ProxyMode = 'auto' | 'base' | 'stealth';

/**
 * Resolved proxy mode returned in responses
 * - "base": Using ANYCRAWL_PROXY_URL (default)
 * - "stealth": Using ANYCRAWL_PROXY_STEALTH_URL
 * - "custom": Using a custom proxy URL
 */
export type ResolvedProxyMode = 'base' | 'stealth' | 'custom';

/** Selector or object form for wait_for_selector (Playwright/Puppeteer only) */
export type WaitForSelector =
    | string
    | { selector: string; timeout?: number; state?: 'attached' | 'visible' | 'hidden' | 'detached' }
    | ({ selector: string; timeout?: number; state?: 'attached' | 'visible' | 'hidden' | 'detached' } | string)[];

export type ScrapeOptionsInput = {
    /**
     * Proxy mode or custom proxy URL.
     * - "auto": Automatically decide between base and stealth proxy
     * - "base": Use ANYCRAWL_PROXY_URL (default)
     * - "stealth": Use ANYCRAWL_PROXY_STEALTH_URL
     * - Custom URL: A full proxy URL string (e.g., "http://user:pass@proxy:8080")
     */
    proxy?: ProxyMode | string;
    formats?: ScrapeFormat[];
    timeout?: number;
    retry?: boolean;
    wait_for?: number;
    wait_until?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    /** Selector(s) to wait for before extraction (browser engines only) */
    wait_for_selector?: WaitForSelector;
    include_tags?: string[];
    exclude_tags?: string[];
    /** When true, filter to main content only; when false, preserve full page structure */
    only_main_content?: boolean;
    json_options?: JsonOptions;
    extract_source?: ExtractSource;
    /** Enable OCR for markdown images */
    ocr_options?: boolean;

    /**
     * Cache max age in milliseconds.
     * - Omit: use server default
     * - 0: skip cache read (force refresh)
     * - > 0: accept cached content within this age
     */
    max_age?: number;

    /**
     * Whether to store this result in Page Cache.
     * Default is true on the server.
     */
    store_in_cache?: boolean;
};

export type ScrapeRequest = {
    url: string;
    engine?: Engine;
    /** Template ID to use (merges with template defaults) */
    template_id?: string;
    /** Template variables for URL/option substitution */
    variables?: Record<string, any>;
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
    links?: string[];
    /**
     * The proxy mode used for this request
     * - "base": Used ANYCRAWL_PROXY_URL (default)
     * - "stealth": Used ANYCRAWL_PROXY_STEALTH_URL
     * - "custom": Used a custom proxy URL
     */
    proxy?: ResolvedProxyMode;
    /** Present on cache hits (ISO string) */
    cachedAt?: string;
    /** Present on cache hits: max age used for the cache read (ms) */
    maxAge?: number;
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
    /** Paths to scrape content from; only matching URLs get content extracted */
    scrape_paths?: string[];
    max_depth?: number;
    strategy?: 'all' | 'same-domain' | 'same-hostname' | 'same-origin';
    limit?: number;
    scrape_options?: Omit<ScrapeOptionsInput, 'retry'>;
};

export type CrawlRequest = {
    url: string;
    engine?: Engine;
    /** Template ID to use */
    template_id?: string;
    /** Template variables for URL/option substitution */
    variables?: Record<string, any>;
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

export type SearchEngine = 'google' | 'searxng' | 'ac-engine';

export type SearchRequest = {
    engine?: SearchEngine;
    query: string;
    limit?: number;
    offset?: number;
    pages?: number;
    lang?: any;
    country?: any;
    /** Time range filter: day | week | month | year */
    timeRange?: 'day' | 'week' | 'month' | 'year';
    /** Search source: web | images | news (SearXNG) */
    sources?: 'web' | 'images' | 'news';
    scrape_options?: (Omit<ScrapeOptionsInput, 'retry'> & {
        engine: Engine;
        /** Scrape-type template for search result follow-up fetches */
        template_id?: string;
        variables?: Record<string, any>;
    });
    /** 0: off, 1: medium, 2: high, null: default (Google only) */
    safe_search?: number | null;
    /** Template ID to use */
    template_id?: string;
    /** Template variables */
    variables?: Record<string, any>;
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

// Map types
export type MapLink = {
    url: string;
    title?: string;
    description?: string;
};

export type MapRequest = {
    url: string;
    limit?: number;
    include_subdomains?: boolean;
    ignore_sitemap?: boolean;
    max_age?: number;
    use_index?: boolean;
};

export type MapResult = {
    links: MapLink[];
};

// Scheduled Tasks
export type ScheduledTaskType = 'scrape' | 'crawl' | 'search' | 'template';
export type ConcurrencyMode = 'skip' | 'queue';

export type CreateScheduledTaskRequest = {
    name: string;
    description?: string | null;
    cron_expression: string;
    timezone?: string;
    task_type: ScheduledTaskType;
    task_payload: Record<string, any>;
    concurrency_mode?: ConcurrencyMode;
    max_executions_per_day?: number | null;
    tags?: string[];
    metadata?: Record<string, any>;
    webhook_ids?: string[];
    webhook_url?: string;
};

export type UpdateScheduledTaskRequest = Partial<CreateScheduledTaskRequest>;

/** Base fields for ScheduledTask (API returns snake_case). All optional for flexibility. */
export interface ScheduledTaskBase {
    task_id?: string;
    name?: string;
    description?: string | null;
    task_type?: ScheduledTaskType;
    task_payload?: Record<string, any>;
    cron_expression?: string;
    timezone?: string;
    concurrency_mode?: ConcurrencyMode;
    max_executions_per_day?: number | null;
    is_active?: boolean;
    is_paused?: boolean;
    pause_reason?: string | null;
    next_execution_at?: string | null;
    last_execution_at?: string | null;
    total_executions?: number;
    successful_executions?: number;
    failed_executions?: number;
    created_at?: string;
    updated_at?: string;
}

export type ScheduledTask = ScheduledTaskBase & Record<string, any>;

export type ScheduledTaskCreateResponse = {
    task_id: string;
    next_execution_at: string | null;
};

/** Base fields for ScheduledTaskExecution (API returns snake_case). All optional for flexibility. */
export interface ScheduledTaskExecutionBase {
    execution_id?: string;
    uuid?: string;
    scheduled_task_uuid?: string;
    execution_number?: number;
    status?: string;
    started_at?: string | null;
    completed_at?: string | null;
    job_uuid?: string | null;
    error_message?: string | null;
    triggered_by?: string;
    scheduled_for?: string;
    created_at?: string;
}

export type ScheduledTaskExecution = ScheduledTaskExecutionBase & Record<string, any>;

export type ScheduledTaskExecutionsResponse = {
    data: ScheduledTaskExecution[];
    meta?: { limit: number; offset: number };
};

// Webhooks
export type CreateWebhookRequest = {
    name: string;
    description?: string;
    webhook_url: string;
    event_types: string[];
    scope?: 'all' | 'specific';
    specific_task_ids?: string[];
    custom_headers?: Record<string, string>;
    timeout_seconds?: number;
    max_retries?: number;
    retry_backoff_multiplier?: number;
    tags?: string[];
    metadata?: Record<string, any>;
};

export type UpdateWebhookRequest = Partial<CreateWebhookRequest>;

/** Base fields for Webhook (API returns snake_case). All optional for flexibility. */
export interface WebhookBase {
    webhook_id?: string;
    name?: string;
    description?: string | null;
    webhook_url?: string;
    event_types?: string[];
    scope?: 'all' | 'specific';
    specific_task_ids?: string[] | null;
    is_active?: boolean;
    total_deliveries?: number;
    successful_deliveries?: number;
    failed_deliveries?: number;
    created_at?: string;
    updated_at?: string;
}

export type Webhook = WebhookBase & Record<string, any>;

export type WebhookCreateResponse = {
    webhook_id: string;
    secret: string;
    message: string;
};

/** Base fields for WebhookDelivery (API returns snake_case). All optional for flexibility. */
export interface WebhookDeliveryBase {
    delivery_id?: string;
    uuid?: string;
    webhook_subscription_uuid?: string;
    event_type?: string;
    status?: string;
    attempt_number?: number;
    response_status?: number | null;
    created_at?: string;
}

export type WebhookDelivery = WebhookDeliveryBase & Record<string, any>;

export type WebhookDeliveriesResponse = {
    data: WebhookDelivery[];
    meta?: { limit: number; offset: number; filters?: any };
};

export type WebhookEventsResponse = {
    event_types: string[];
    categories: Record<string, string[]>;
};
