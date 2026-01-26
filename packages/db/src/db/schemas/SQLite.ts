import * as p from "drizzle-orm/sqlite-core";
import { randomUUID } from "crypto";

export const apiKey = p.sqliteTable("api_key", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key value - must be unique
    key: p.text("key").notNull().unique(),
    // user uuid
    user: p.text("user"),
    // Display name for the API key
    name: p.text("name").default("default"),
    // Whether the key is currently active
    isActive: p.integer("is_active", { mode: "boolean" }).notNull().default(true),
    // User/system that created this key
    createdBy: p.integer("created_by").default(-1),
    // Available credit balance
    credits: p.integer("credits").notNull().default(0),
    // Timestamp when the key was created
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    // Timestamp of last API key usage
    lastUsedAt: p.integer("last_used_at", { mode: "timestamp" }),
    // Optional expiration timestamp
    expiresAt: p.integer("expires_at", { mode: "timestamp" }),
    // Allowed IP addresses whitelist (JSON array of IP addresses or CIDR ranges)
    allowedIps: p.text("allowed_ips", { mode: "json" }).$type<string[]>(),
});

export const requestLog = p.sqliteTable("request_log", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key that made the request
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
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
    requestPayload: p.text("request_payload", { mode: "json" }).$type<string[]>(),
    // Request header
    requestHeader: p.text("request_header", { mode: "json" }).$type<string[]>(),
    // Response body
    responseBody: p.text("response_body", { mode: "json" }).$type<string[]>(),
    // Response header
    responseHeader: p.text("response_header", { mode: "json" }).$type<string[]>(),
    // Success or not
    success: p.integer("success", { mode: "boolean" }).notNull().default(true),
    // create at
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const jobs = p.sqliteTable("jobs", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // job id
    jobId: p.text("job_id").notNull(),
    // job type
    jobType: p.text("job_type").notNull(),
    // job queue name
    jobQueueName: p.text("job_queue_name").notNull(),
    // job expire at
    jobExpireAt: p.integer("job_expire_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date(Date.now() + 3 * 60 * 60 * 1000)),
    // url
    url: p.text("url").notNull(),
    // payload from job
    payload: p.text("payload", { mode: "json" }).$type<string[]>(),
    // api key
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
    // total urls/pages found
    total: p.integer("total").notNull().default(0),
    // completed urls/pages
    completed: p.integer("completed").notNull().default(0),
    // failed urls/pages
    failed: p.integer("failed").notNull().default(0),
    // Number of credits consumed
    creditsUsed: p.integer("credits_used").notNull().default(0),
    // Network traffic usage (application layer bytes)
    trafficBytes: p.integer("traffic_bytes").notNull().default(0),
    trafficRequestBytes: p.integer("traffic_request_bytes").notNull().default(0),
    trafficResponseBytes: p.integer("traffic_response_bytes").notNull().default(0),
    trafficRequestCount: p.integer("traffic_request_count").notNull().default(0),
    // Origin, playground or api
    origin: p.text("origin").notNull(),
    // status of job
    status: p.text("status").notNull(),
    // job success or not
    isSuccess: p.integer("is_success", { mode: "boolean" }).notNull().default(false),
    // job error message
    errorMessage: p.text("error_message"),
    // job created at
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
    // job updated at
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const jobResults = p.sqliteTable("job_results", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // job uuid
    jobUuid: p.text("job_uuid").notNull().references(() => jobs.uuid),
    // url
    url: p.text("url").notNull(),
    // data
    data: p.text("data", { mode: "json" }).$type<string[]>(),
    // status
    status: p.text("status").notNull(),
    // created at
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
    // updated at
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull(),
});

// Template system tables
export const templates = p.sqliteTable("templates", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Template ID (business identifier)
    templateId: p.text("template_id").notNull().unique(),
    // Template name
    name: p.text("name").notNull(),
    // Template description
    description: p.text("description"),
    // Template tags (JSON array)
    tags: p.text("tags", { mode: "json" }).notNull(),
    // Template version
    version: p.text("version").notNull().default("1.0.0"),
    // Template type - determines which operation this template supports
    templateType: p.text("template_type").notNull().default("scrape"),
    // Pricing information (JSON): { perCall: number, currency: "credits" }
    pricing: p.text("pricing", { mode: "json" }).notNull(),
    // Request options configuration (JSON) - supports scrape, crawl, and search
    reqOptions: p.text("req_options", { mode: "json" }).notNull(),
    // Custom handlers code (JSON)
    customHandlers: p.text("custom_handlers", { mode: "json" }),
    // Template metadata (JSON)
    metadata: p.text("metadata", { mode: "json" }).notNull(),
    // Template variables (JSON): { [key: string]: { type: string, description: string, required: boolean, defaultValue?: any } }
    variables: p.text("variables", { mode: "json" }),
    // User information
    createdBy: p.text("created_by").notNull(),
    publishedBy: p.text("published_by"),
    reviewedBy: p.text("reviewed_by"),
    // Status fields
    status: p.text("status").default("draft").notNull(),
    reviewStatus: p.text("review_status").default("pending").notNull(),
    reviewNotes: p.text("review_notes"),
    // Trusted flag - if true, can use AsyncFunction with page object; if false, must use VM sandbox
    trusted: p.integer("trusted", { mode: "boolean" }).notNull().default(false),
    // Timestamps
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    publishedAt: p.integer("published_at", { mode: "timestamp" }),
    reviewedAt: p.integer("reviewed_at", { mode: "timestamp" }),
    archivedAt: p.integer("archived_at", { mode: "timestamp" }),
});

export const templateExecutions = p.sqliteTable("template_executions", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Foreign key to templates
    templateUuid: p.text("template_uuid").notNull().references(() => templates.uuid),
    // API key that made the request
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
    // Job information
    jobUuid: p.text("job_uuid").references(() => jobs.uuid),
    // Request processing time in milliseconds
    processingTimeMs: p.real("processing_time_ms").notNull(),
    // Number of credits consumed
    creditsCharged: p.integer("credits_charged").default(0).notNull(),
    // Success or not
    success: p.integer("success", { mode: "boolean" }).notNull(),
    // Error message if failed
    errorMessage: p.text("error_message"),
    // Timestamp
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});
