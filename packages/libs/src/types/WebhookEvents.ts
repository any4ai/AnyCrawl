/**
 * Webhook Event Types
 * All supported webhook events in the AnyCrawl system
 */

export enum WebhookEventType {
    // Scrape job events
    SCRAPE_CREATED = "scrape.created",
    SCRAPE_STARTED = "scrape.started",
    SCRAPE_COMPLETED = "scrape.completed",
    SCRAPE_FAILED = "scrape.failed",
    SCRAPE_CANCELLED = "scrape.cancelled",

    // Crawl job events
    CRAWL_CREATED = "crawl.created",
    CRAWL_STARTED = "crawl.started",
    CRAWL_COMPLETED = "crawl.completed",
    CRAWL_FAILED = "crawl.failed",
    CRAWL_CANCELLED = "crawl.cancelled",

    // Search job events
    SEARCH_CREATED = "search.created",
    SEARCH_STARTED = "search.started",
    SEARCH_COMPLETED = "search.completed",
    SEARCH_FAILED = "search.failed",

    // Map job events
    MAP_CREATED = "map.created",
    MAP_STARTED = "map.started",
    MAP_COMPLETED = "map.completed",
    MAP_FAILED = "map.failed",

    // Scheduled task events
    TASK_EXECUTED = "task.executed",
    TASK_FAILED = "task.failed",
    TASK_PAUSED = "task.paused",
    TASK_RESUMED = "task.resumed",

    // Monitor events
    MONITOR_CHECK_COMPLETED = "monitor.check.completed",
    MONITOR_CHANGED = "monitor.changed",
    MONITOR_PRICE_CHANGED = "monitor.price.changed",
    MONITOR_ERROR = "monitor.error",

    // Webhook test event
    WEBHOOK_TEST = "webhook.test",
}

export const WEBHOOK_EVENT_TYPES = Object.values(WebhookEventType);

/**
 * Webhook event payload structures
 */
export interface JobEventPayload {
    job_id: string;
    status: string;
    url: string;
    total?: number;
    completed?: number;
    failed?: number;
    credits_used?: number;
    error_message?: string;
    created_at: string;
    completed_at?: string;
}

export interface TaskEventPayload {
    task_id: string;
    task_name: string;
    execution_id: string;
    execution_number: number;
    status: string;
    job_id?: string;
    credits_used?: number;
    error_message?: string;
    scheduled_for: string;
    completed_at?: string;
}

export interface WebhookTestPayload {
    message: string;
    timestamp: string;
    webhook_id: string;
}

export interface MonitorFieldDiff {
    path: string;
    from: any;
    to: any;
    delta?: number;
}

export interface MonitorCheckSummary {
    total: number;
    same: number;
    changed: number;
    new: number;
    removed: number;
    error: number;
}

/**
 * Monitor event payload. Unlike JobEventPayload, monitor events carry the change
 * content inline (diff text / field diffs / AI judgment) so consumers can act
 * without a callback fetch.
 */
export interface MonitorEventPayload {
    monitor_id: string;
    monitor_name: string;
    monitor_type: string;
    url?: string;
    change_type?: string;
    summary?: MonitorCheckSummary;
    diff_text?: string;
    diff_json?: MonitorFieldDiff[];
    judgment?: { meaningful: boolean; confidence: string; reason: string };
    captured_at: string;
}

export type WebhookPayload =
    | JobEventPayload
    | TaskEventPayload
    | MonitorEventPayload
    | WebhookTestPayload;
