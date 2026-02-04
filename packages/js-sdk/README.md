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

// Scrape
const scrape = await client.scrape({
    url: "https://example.com",
    engine: "cheerio",
    formats: ["markdown"],
});

// Crawl (async job)
const job = await client.createCrawl({
    url: "https://anycrawl.dev",
    engine: "cheerio",
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
        engine: "cheerio",
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

const engine: Engine = "cheerio";
const formats: ScrapeFormat[] = ["markdown", "html"];

await client.scrape({
    url: "https://example.com",
    engine,
    // Optional:
    proxy: "http://user:pass@host:port",
    formats,
    timeout: 60_000,
    retry: true,
    wait_for: 3000,
    include_tags: ["article", "main"],
    exclude_tags: ["nav", "footer"],
    json_options: { user_prompt: "Extract title", schema: { type: "object" } },
    extract_source: "markdown", // or "html"
});
```

Returns either a success object with content or a failure with `error`.

### createCrawl(input), getCrawlStatus(jobId), getCrawlResults(jobId, skip?), cancelCrawl(jobId)

```ts
const job = await client.createCrawl({
    url: "https://site.com/docs",
    engine: "playwright",
    max_depth: 5,
    strategy: "same-domain",
    limit: 100,
    scrape_options: { formats: ["markdown"] },
    include_paths: ["/docs/*"],
    exclude_paths: ["/admin/*"],
});

const status = await client.getCrawlStatus(job.job_id);
const page = await client.getCrawlResults(job.job_id, 0);
// await client.cancelCrawl(job.job_id);
```

### crawl(input, pollIntervalSeconds = 2, timeoutMs?)

Convenience wrapper that creates a crawl, polls status until it completes, and returns aggregated results of all pages. Throws on failed/cancelled jobs or when the timeout is reached.

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
            engine: "cheerio",
            max_depth: 3,
            strategy: "same-domain",
            limit: 50,
            // Scrape options are nested under scrape_options
            scrape_options: { formats: ["markdown"] },
        },
        3, // poll every 3s
        5 * 60_000 // timeout after 5 minutes
    );
    console.log(aggregated.total, aggregated.completed);
    console.log(aggregated.data.length, "pages aggregated");
} catch (err) {
    // Handles API/network/auth errors, job failed/cancelled, or timeout
    console.error(err);
}
```

- Returns: `CrawlAndWaitResult` with `job_id`, `status`, `total`, `completed`, `creditsUsed`, and aggregated `data`.
- Polling states: waits until `completed`; throws on `failed` or `cancelled`.
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

Notes:

- scrape has no `scrape_options`.
- crawl only accepts nested `scrape_options`; top-level only allows crawl strategy fields and optional `retry`.
- search supports optional `scrape_options`; when provided, it must include its `engine`.

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

Type definitions are exported from `@anycrawl/js-sdk` for TypeScript users.
