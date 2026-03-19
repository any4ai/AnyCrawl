# @anycrawl/js-sdk

A lightweight ESM JavaScript/TypeScript client for the AnyCrawl API.

## Requirements

- Node.js 18+ (Node 20 recommended – matches CI)
- ESM modules

## Install

```bash
pnpm add @anycrawl/js-sdk
```

## Quickstart

```ts
import { AnyCrawlClient } from "@anycrawl/js-sdk";

// Prefer loading from env in your app framework
const client = new AnyCrawlClient(process.env.ANYCRAWL_API_KEY || "<YOUR_API_KEY>");
// Base URL defaults to https://api.anycrawl.dev, but you can override:
// const client = new AnyCrawlClient(process.env.ANYCRAWL_API_KEY!, "https://api.anycrawl.dev");

// Health
await client.healthCheck(); // -> { status: "ok" }

// Scrape (engine defaults to "auto" — automatically picks the best engine)
const scrape = await client.scrape({
    url: "https://example.com",
    formats: ["markdown"],
});

// Crawl (async job)
const job = await client.createCrawl({
    url: "https://anycrawl.dev",
    max_depth: 3,
    strategy: "same-domain",
    limit: 50,
    scrape_options: { formats: ["markdown"] },
});
const status = await client.getCrawlStatus(job.job_id);
const page1 = await client.getCrawlResults(job.job_id, 0);

// Cancel if needed
// await client.cancelCrawl(job.job_id);

// Blocking helper (waits until the crawl finishes and aggregates all pages)
const aggregated = await client.crawl(
    {
        url: "https://anycrawl.dev",
        max_depth: 3,
        strategy: "same-domain",
        limit: 50,
    },
    2, // poll interval (seconds)
    10 * 60_000 // optional timeout (ms)
);
// aggregated.data contains all results

// Map (discover all URLs from a website)
const mapResult = await client.map({
    url: "https://anycrawl.dev",
    limit: 100,
    include_subdomains: false,
    ignore_sitemap: false,
});
// mapResult.links contains all discovered URLs

// Search (optionally enrich with scraping)
const results = await client.search({
    query: "OpenAI ChatGPT",
    engine: "google",
    pages: 1,
    limit: 10,
    scrape_options: { engine: "cheerio", formats: ["markdown"] },
});
```

## Usage details

### Client

```ts
new AnyCrawlClient(apiKey: string, baseUrl = "https://api.anycrawl.dev", onAuthFailure?: () => void)
```

- `apiKey`: Bearer token for API calls.
- `baseUrl`: Override if self-hosting.
- `onAuthFailure`: Invoked on 401/403. Useful to trigger sign-out or refresh.

You can also set `LOG_LEVEL` to control internal logs (`debug`, `info`, `warn`, `error`).

### scrape(input)

```ts
import type { Engine, ScrapeFormat } from "@anycrawl/js-sdk";

const engine: Engine = "auto"; // or "cheerio", "playwright", "puppeteer"
const formats: ScrapeFormat[] = ["markdown", "html"];

await client.scrape({
    url: "https://example.com",
    engine, // optional — defaults to "auto"
    // Optional:
    template_id: "my-template",
    variables: { key: "value" },
    proxy: "http://user:pass@host:port",
    formats,
    timeout: 60_000,
    retry: true,
    wait_for: 3000,
    wait_for_selector: ".content",
    only_main_content: true,
    include_tags: ["article", "main"],
    exclude_tags: ["nav", "footer"],
    json_options: { user_prompt: "Extract title", schema: { type: "object" } },
    extract_source: "markdown", // or "html"
    ocr_options: false,
    max_age: 86_400_000,
    store_in_cache: true,
});
```

Returns either a success object with content or a failure with `error`.

### createCrawl(input), getCrawlStatus(jobId), getCrawlResults(jobId, skip?), cancelCrawl(jobId)

```ts
const job = await client.createCrawl({
    url: "https://site.com/docs",
    engine: "playwright", // optional — defaults to "auto"
    template_id: "my-template",
    variables: { section: "api" },
    max_depth: 5,
    strategy: "same-domain",
    limit: 100,
    include_paths: ["/docs/*"],
    exclude_paths: ["/admin/*"],
    scrape_paths: ["/docs/*"], // Only scrape content from these paths
    scrape_options: { formats: ["markdown"] },
});

const status = await client.getCrawlStatus(job.job_id);
const page = await client.getCrawlResults(job.job_id, 0);
// await client.cancelCrawl(job.job_id);
```

### crawl(input, pollIntervalSeconds = 2, timeoutMs?)

Convenience wrapper that creates a crawl, polls status until it completes, and returns aggregated results of all pages. Throws on failed jobs or timeout; returns partial aggregated data when cancelled.

```ts
// Type signature
async function crawl(
    input: CrawlRequest,
    pollIntervalSeconds?: number, // default 2s
    timeoutMs?: number // optional
): Promise<CrawlAndWaitResult>;

// Example
try {
    const aggregated = await client.crawl(
        {
            url: "https://anycrawl.dev",
            max_depth: 3,
            strategy: "same-domain",
            limit: 50,
            scrape_options: { formats: ["markdown"] },
        },
        3, // poll every 3s
        5 * 60_000 // timeout after 5 minutes
    );
    console.log(aggregated.total, aggregated.completed);
    console.log(aggregated.data.length, "pages aggregated");
} catch (err) {
    // Handles API/network/auth errors, job failed, or timeout
    console.error(err);
}
```

- Returns: `CrawlAndWaitResult` with `job_id`, `status`, `total`, `completed`, `creditsUsed`, and aggregated `data`.
- Polling states: waits until `completed`; throws on `failed`; returns partial data when `cancelled`.
- Use `getCrawlStatus`/`getCrawlResults` if you prefer manual pagination/progress.

### search(input)

```ts
await client.search({
    query: "best js tutorials",
    engine: "google",
    limit: 20,
    offset: 0,
    pages: 2,
    lang: "en",
    country: "US",
    timeRange: "week",
    sources: "web",
    template_id: "search-template",
    variables: {},
    scrape_options: { engine: "cheerio", formats: ["markdown"] },
    safe_search: 1,
});
```

### map(input)

```ts
await client.map({
    url: "https://example.com",
    limit: 100,
    include_subdomains: false,
    ignore_sitemap: false,
});
```

Discovers all URLs from a website using multiple sources:
- Sitemap parsing (sitemap.xml, robots.txt)
- Search engine results (site: operator)
- Page link extraction (HTML <a href> tags)

Returns `MapResult` with `links` array containing `{ url, title?, description? }` objects.

### Scheduled Tasks

```ts
// Create
const created = await client.createScheduledTask({
    name: "Daily scrape",
    cron_expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
    task_type: "scrape",
    task_payload: { url: "https://example.com", engine: "cheerio", formats: ["markdown"] },
    concurrency_mode: "skip",
    max_executions_per_day: 1,
});
// created.task_id, created.next_execution_at

// List, get, update, delete
const tasks = await client.listScheduledTasks();
const task = await client.getScheduledTask(created.task_id);
await client.updateScheduledTask(created.task_id, { cron_expression: "0 10 * * *" });
await client.pauseScheduledTask(created.task_id, "Maintenance");
await client.resumeScheduledTask(created.task_id);
await client.deleteScheduledTask(created.task_id);

// Executions
const { data } = await client.getScheduledTaskExecutions(created.task_id, { limit: 10, offset: 0 });
await client.cancelScheduledTaskExecution(created.task_id, executionId);
```

### Webhooks

```ts
// Create
const webhook = await client.createWebhook({
    name: "My webhook",
    webhook_url: "https://your-server.com/webhook",
    event_types: ["scrape.completed", "crawl.completed"],
    scope: "all",
});
// webhook.webhook_id, webhook.secret (save secret - shown only once)

// List, get, update, delete
const webhooks = await client.listWebhooks();
const w = await client.getWebhook(webhook.webhook_id);
await client.updateWebhook(webhook.webhook_id, { event_types: ["scrape.completed"] });
await client.deleteWebhook(webhook.webhook_id);

// Deliveries, test, activate/deactivate
const { data } = await client.getWebhookDeliveries(webhook.webhook_id, { limit: 20, status: "failed" });
await client.testWebhook(webhook.webhook_id);
await client.activateWebhook(webhook.webhook_id);
await client.deactivateWebhook(webhook.webhook_id);
await client.replayWebhookDelivery(webhook.webhook_id, deliveryId);

// Supported event types
const events = await client.getWebhookEvents();
// events.event_types, events.categories
```

Notes:

- Engine defaults to `auto` when omitted — the server automatically picks the best engine (`cheerio` for static pages, `playwright` for JS-heavy pages).
- Scrape options live at top-level; crawl accepts nested `scrape_options` only; top-level only allows crawl strategy fields and optional `retry`.
- search supports optional `scrape_options`; when provided without `engine`, it is omitted (no per-result scrape enrichment; API defaults to auto when enrichment is used).

## Running E2E tests

Live integration tests hit the real AnyCrawl API and consume credits. They are **not** included in the default `pnpm test` or `pnpm test:coverage` runs.

### Prerequisites

- A valid `ANYCRAWL_API_KEY`
- Set `ANYCRAWL_RUN_LIVE=1` to opt in (dual gate prevents accidental execution in CI)
- (Optional) `ANYCRAWL_BASE_URL` to test against a self-hosted instance (defaults to `https://api.anycrawl.dev`)

### Run

```bash
# Inline env vars
ANYCRAWL_API_KEY=sk-xxx ANYCRAWL_RUN_LIVE=1 pnpm --filter @anycrawl/js-sdk test:e2e

# Or configure in root .env and run:
pnpm --filter @anycrawl/js-sdk test:e2e
```

The test suite is organized in tiers by credit cost:

| Tier | Tests | Credit cost |
|------|-------|-------------|
| 1 | healthCheck, scrape (cheerio), map | Zero / low |
| 2 | Multi-engine scrape, search, createCrawl + status | Moderate |
| 3 | Blocking crawl, cancelCrawl, full pagination flow | Higher |
| Error | Invalid API key | Zero |

## Error handling

All methods throw standard `Error` with readable messages. Examples:

- Authentication errors: `Authentication failed: <message>` (401/403) – triggers `onAuthFailure` if provided
- Payment required: `Payment required: <message>. current_credits=<n>` (402)
- API errors: `API Error <status>: <message>`
- Network issues: `Network error: Unable to reach AnyCrawl API`
- Other request errors: `Request error: <message>`

Wrap calls in `try/catch` to handle errors in your app.

Notes:

- Some endpoints return HTTP 2xx with `{ success: false, error?: string }`. The SDK converts these into `Request error: <message>` (e.g., `Request error: Scraping failed`).
- 401 and 403 are both treated as authentication failures and will invoke `onAuthFailure` when set.
- For 402, when the response includes `current_credits`, the message is specialized as shown above; otherwise it falls back to `API Error 402: <message>`.

## API surface

**Core**
- `healthCheck(): Promise<{ status: string }>`
- `setAuthFailureCallback(cb: () => void): void`
- `scrape(input: ScrapeRequest): Promise<ScrapeResult>`
- `createCrawl(input: CrawlRequest): Promise<CrawlJobResponse>`
- `getCrawlStatus(jobId: string): Promise<CrawlStatusResponse>`
- `getCrawlResults(jobId: string, skip?: number): Promise<CrawlResultsResponse>`
- `crawl(input: CrawlRequest, pollIntervalSeconds?: number, timeoutMs?: number): Promise<CrawlAndWaitResult>`
- `cancelCrawl(jobId: string): Promise<{ job_id: string; status: string }>`
- `search(input: SearchRequest): Promise<SearchResult[]>`
- `map(input: MapRequest): Promise<MapResult>`

**Scheduled Tasks**
- `createScheduledTask(input): Promise<ScheduledTaskCreateResponse>`
- `listScheduledTasks(): Promise<ScheduledTask[]>`
- `getScheduledTask(taskId): Promise<ScheduledTask>`
- `updateScheduledTask(taskId, input): Promise<ScheduledTask>`
- `pauseScheduledTask(taskId, reason?): Promise<void>`
- `resumeScheduledTask(taskId): Promise<void>`
- `deleteScheduledTask(taskId): Promise<void>`
- `getScheduledTaskExecutions(taskId, params?): Promise<ScheduledTaskExecutionsResponse>`
- `cancelScheduledTaskExecution(taskId, executionId): Promise<void>`

**Webhooks**
- `createWebhook(input): Promise<WebhookCreateResponse>`
- `listWebhooks(): Promise<Webhook[]>`
- `getWebhook(webhookId): Promise<Webhook>`
- `updateWebhook(webhookId, input): Promise<void>`
- `deleteWebhook(webhookId): Promise<void>`
- `getWebhookDeliveries(webhookId, params?): Promise<WebhookDeliveriesResponse>`
- `testWebhook(webhookId): Promise<void>`
- `activateWebhook(webhookId): Promise<void>`
- `deactivateWebhook(webhookId): Promise<void>`
- `replayWebhookDelivery(webhookId, deliveryId): Promise<void>`
- `getWebhookEvents(): Promise<WebhookEventsResponse>`

Type definitions are exported from `@anycrawl/js-sdk` for TypeScript users.
