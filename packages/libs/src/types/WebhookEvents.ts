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

export type WebhookPayload = JobEventPayload | TaskEventPayload | WebhookTestPayload;
