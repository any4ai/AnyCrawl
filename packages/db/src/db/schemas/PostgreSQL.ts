import * as p from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";

export const apiKey = p.pgTable("api_key", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // user uuid
    user: p.uuid("user"),
    // API key value - must be unique
    key: p.text("key").notNull().unique(),
    // Display name for the API key
    name: p.text("name").default("default"),
    // Whether the key is currently active
    isActive: p.boolean("is_active").notNull().default(true),
    // User/system that created this key
    createdBy: p.integer("created_by").default(-1),
    // Available credit balance
    credits: p.integer("credits").notNull().default(0),
    // Timestamp when the key was created
    createdAt: p.timestamp("created_at").notNull(),
    // Timestamp of last API key usage
    lastUsedAt: p.timestamp("last_used_at"),
    // Optional expiration timestamp
    expiresAt: p.timestamp("expires_at"),
    // Allowed IP addresses whitelist (JSON array of IP addresses or CIDR ranges)
    allowedIps: p.jsonb("allowed_ips").$type<string[]>(),
    // Subscription tier for rate limiting (free, paid, etc.)
    subscriptionTier: p.text("subscription_tier").default("free").notNull(),
});

export const requestLog = p.pgTable("request_log", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key that made the request
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.uuid("user_id"),
    // path that was called
    path: p.text("path").notNull(),
    // HTTP method used
    method: p.text("method").notNull(),
    // Response status code
    statusCode: p.integer("status_code").notNull(),
    // Request processing time in milliseconds
    processingTimeMs: p.real("processing_time_ms").notNull(),
    // Number of credits consumed
    creditsUsed: p.integer("credits_used").notNull().default(0),
    // Request IP address
    ipAddress: p.text("ip_address"),
    // User agent string
    userAgent: p.text("user_agent"),
    // Request body
    requestPayload: p.jsonb("request_payload"),
    // Request header
    requestHeader: p.jsonb("request_header"),
    // Response body
    responseBody: p.jsonb("response_body"),
    // Response header
    responseHeader: p.jsonb("response_header"),
    // Success or not
    success: p.boolean("success").notNull().default(true),
    // create at
    createdAt: p.timestamp("created_at").notNull(),
});

export const jobs = p.pgTable("jobs", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // job id
    jobId: p.text("job_id").notNull(),
    // job type
    jobType: p.text("job_type").notNull(),
    // job queue name
    jobQueueName: p.text("job_queue_name").notNull(),
    // job expire at
    jobExpireAt: p.timestamp("job_expire_at").notNull().$defaultFn(() => new Date(Date.now() + 3 * 60 * 60 * 1000)),
    // url
    url: p.text("url").notNull(),
    // payload from job
    payload: p.jsonb("payload"),
    // api key
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user or api_key.uuid)
    userId: p.uuid("user_id"),
    // total urls/pages found
    total: p.integer("total").notNull().default(0),
    // completed urls/pages
    completed: p.integer("completed").notNull().default(0),
    // failed urls/pages
    failed: p.integer("failed").notNull().default(0),
    // Number of credits consumed
    creditsUsed: p.integer("credits_used").notNull().default(0),
    // Credit deduction timestamp (null = not yet deducted, set when deduction completes)
    deductedAt: p.timestamp("deducted_at"),
    // Network traffic usage (application layer bytes)
    trafficBytes: p.bigint("traffic_bytes", { mode: "number" }).notNull().default(0),
    trafficRequestBytes: p.bigint("traffic_request_bytes", { mode: "number" }).notNull().default(0),
    trafficResponseBytes: p.bigint("traffic_response_bytes", { mode: "number" }).notNull().default(0),
    trafficRequestCount: p.integer("traffic_request_count").notNull().default(0),
    // Origin, playground or api
    origin: p.text("origin").notNull(),
    // status of job
    status: p.text("status").notNull(),
    // job success or not
    isSuccess: p.boolean("is_success").notNull().default(false),
    // job error message
    errorMessage: p.text("error_message"),
    // job created at
    createdAt: p.timestamp("created_at").notNull(),
    // job updated at
    updatedAt: p.timestamp("updated_at").notNull(),
});

export const jobResults = p.pgTable("job_results", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // job uuid
    jobUuid: p.uuid("job_uuid").references(() => jobs.uuid),
    // url
    url: p.text("url").notNull(),
    // data
    data: p.jsonb("data"),
    // status
    status: p.text("status").notNull(),
    // created at
    createdAt: p.timestamp("created_at").notNull(),
    // updated at
    updatedAt: p.timestamp("updated_at").notNull(),
});

// Template system tables
export const templates = p.pgTable("templates", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Template ID (business identifier)
    templateId: p.text("template_id").notNull().unique(),
    // Template name
    name: p.text("name").notNull(),
    // Template description
    description: p.text("description"),
    // Template tags (JSON array)
    tags: p.jsonb("tags").notNull(),
    // Template version
    version: p.text("version").notNull().default("1.0.0"),
    // Template type - determines which operation this template supports
    templateType: p.text("template_type").notNull().default("scrape"),
    // Pricing information (JSON): { perCall: number, currency: "credits" }
    pricing: p.jsonb("pricing").notNull(),
    // Request options configuration (JSON) - supports scrape, crawl, and search
    reqOptions: p.jsonb("req_options").notNull(),
    // Custom handlers code (JSON)
    customHandlers: p.jsonb("custom_handlers"),
    // Template metadata (JSON)
    metadata: p.jsonb("metadata").notNull(),
    // Template variables (JSON): { [key: string]: { type: string, description: string, required: boolean, defaultValue?: any } }
    variables: p.jsonb("variables"),
    // User information
    createdBy: p.text("created_by").notNull(),
    publishedBy: p.text("published_by"),
    reviewedBy: p.text("reviewed_by"),
    // Status fields
    status: p.text("status").default("draft").notNull(),
    reviewStatus: p.text("review_status").default("pending").notNull(),
    reviewNotes: p.text("review_notes"),
    // Trusted flag - if true, can use AsyncFunction with page object; if false, must use VM sandbox
    trusted: p.boolean("trusted").notNull().default(false),
    // Timestamps
    createdAt: p.timestamp("created_at").notNull(),
    updatedAt: p.timestamp("updated_at").notNull(),
    publishedAt: p.timestamp("published_at"),
    reviewedAt: p.timestamp("reviewed_at"),
    archivedAt: p.timestamp("archived_at"),
});

export const templateExecutions = p.pgTable("template_executions", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Foreign key to templates
    templateUuid: p.uuid("template_uuid").notNull().references(() => templates.uuid),
    // API key that made the request
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.uuid("user_id"),
    // Job information
    jobUuid: p.uuid("job_uuid").references(() => jobs.uuid),
    // Request processing time in milliseconds
    processingTimeMs: p.real("processing_time_ms").notNull(),
    // Number of credits consumed
    creditsCharged: p.integer("credits_charged").default(0).notNull(),
    // Success or not
    success: p.boolean("success").notNull(),
    // Error message if failed
    errorMessage: p.text("error_message"),
    // Timestamp
    createdAt: p.timestamp("created_at").notNull(),
});

// Scheduled Tasks and Webhooks tables
export const scheduledTasks = p.pgTable("scheduled_tasks", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key that created this task
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.uuid("user_id"),
    name: p.text("name").notNull(),
    description: p.text("description"),
    taskType: p.text("task_type").notNull(),
    taskPayload: p.jsonb("task_payload").notNull(),
    cronExpression: p.text("cron_expression").notNull(),
    timezone: p.text("timezone").default("UTC").notNull(),
    concurrencyMode: p.text("concurrency_mode").default("skip").notNull(),
    maxExecutionsPerDay: p.integer("max_executions_per_day"),
    minCreditsRequired: p.integer("min_credits_required").default(1).notNull(),
    isActive: p.boolean("is_active").default(true).notNull(),
    isPaused: p.boolean("is_paused").default(false).notNull(),
    pauseReason: p.text("pause_reason"),
    lastExecutionAt: p.timestamp("last_execution_at", { withTimezone: true }),
    nextExecutionAt: p.timestamp("next_execution_at", { withTimezone: true }),
    totalExecutions: p.integer("total_executions").default(0).notNull(),
    successfulExecutions: p.integer("successful_executions").default(0).notNull(),
    failedExecutions: p.integer("failed_executions").default(0).notNull(),
    consecutiveFailures: p.integer("consecutive_failures").default(0).notNull(),
    tags: p.jsonb("tags"),
    metadata: p.jsonb("metadata"),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const taskExecutions = p.pgTable("task_executions", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    scheduledTaskUuid: p.uuid("scheduled_task_uuid").notNull().references(() => scheduledTasks.uuid, { onDelete: "cascade" }),
    executionNumber: p.integer("execution_number").notNull(),
    idempotencyKey: p.text("idempotency_key").notNull().unique(),
    status: p.text("status").default("pending").notNull(),
    startedAt: p.timestamp("started_at", { withTimezone: true }),
    completedAt: p.timestamp("completed_at", { withTimezone: true }),
    durationMs: p.integer("duration_ms"),
    jobUuid: p.uuid("job_uuid").references(() => jobs.uuid),
    creditsUsed: p.integer("credits_used").default(0).notNull(),
    itemsProcessed: p.integer("items_processed").default(0).notNull(),
    itemsSucceeded: p.integer("items_succeeded").default(0).notNull(),
    itemsFailed: p.integer("items_failed").default(0).notNull(),
    errorMessage: p.text("error_message"),
    errorCode: p.text("error_code"),
    errorDetails: p.jsonb("error_details"),
    triggeredBy: p.text("triggered_by").default("scheduler").notNull(),
    scheduledFor: p.timestamp("scheduled_for", { withTimezone: true }).notNull(),
    metadata: p.jsonb("metadata"),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const webhookSubscriptions = p.pgTable("webhook_subscriptions", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key that created this webhook
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.uuid("user_id"),
    name: p.text("name").notNull(),
    description: p.text("description"),
    webhookUrl: p.text("webhook_url").notNull(),
    webhookSecret: p.text("webhook_secret").notNull(),
    scope: p.text("scope").default("all").notNull(),
    specificTaskIds: p.jsonb("specific_task_ids"),
    eventTypes: p.jsonb("event_types").notNull(),
    customHeaders: p.jsonb("custom_headers"),
    timeoutSeconds: p.integer("timeout_seconds").default(10).notNull(),
    maxRetries: p.integer("max_retries").default(3).notNull(),
    retryBackoffMultiplier: p.real("retry_backoff_multiplier").default(2).notNull(),
    isActive: p.boolean("is_active").default(true).notNull(),
    consecutiveFailures: p.integer("consecutive_failures").default(0).notNull(),
    autoDisableAfterFailures: p.integer("auto_disable_after_failures").default(10).notNull(),
    lastSuccessAt: p.timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: p.timestamp("last_failure_at", { withTimezone: true }),
    totalDeliveries: p.integer("total_deliveries").default(0).notNull(),
    successfulDeliveries: p.integer("successful_deliveries").default(0).notNull(),
    failedDeliveries: p.integer("failed_deliveries").default(0).notNull(),
    tags: p.jsonb("tags"),
    metadata: p.jsonb("metadata"),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const webhookDeliveries = p.pgTable("webhook_deliveries", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    webhookSubscriptionUuid: p.uuid("webhook_subscription_uuid").notNull().references(() => webhookSubscriptions.uuid, { onDelete: "cascade" }),
    eventType: p.text("event_type").notNull(),
    eventSource: p.text("event_source").notNull(),
    eventSourceId: p.uuid("event_source_id").notNull(),
    status: p.text("status").default("pending").notNull(),
    attemptNumber: p.integer("attempt_number").default(1).notNull(),
    maxAttempts: p.integer("max_attempts").default(3).notNull(),
    requestUrl: p.text("request_url").notNull(),
    requestMethod: p.text("request_method").default("POST").notNull(),
    requestHeaders: p.jsonb("request_headers"),
    requestBody: p.jsonb("request_body"),
    responseStatus: p.integer("response_status"),
    responseHeaders: p.jsonb("response_headers"),
    responseBody: p.text("response_body"),
    responseDurationMs: p.integer("response_duration_ms"),
    errorMessage: p.text("error_message"),
    errorCode: p.text("error_code"),
    nextRetryAt: p.timestamp("next_retry_at", { withTimezone: true }),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    deliveredAt: p.timestamp("delivered_at", { withTimezone: true }),
});
