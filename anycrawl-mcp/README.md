# AnyCrawl MCP Server

🚀 **AnyCrawl MCP Server** — Powerful web scraping and crawling for Cursor, Claude, and other LLM clients via the Model Context Protocol (MCP).

## Features

- **Web Scraping**: Extract content from single URLs with multiple output formats
- **Website Crawling**: Crawl entire websites with configurable depth and limits
- **Search Engine Integration**: Search the web and optionally scrape results
- **Multiple Engines**: Auto mode (intelligent selection), Playwright, Cheerio, and Puppeteer
- **Flexible Output**: Markdown, HTML, text, screenshots, and structured JSON
- **Async Operations**: Non-blocking crawl jobs with status monitoring
- **Error Handling**: Robust error handling and logging
- **Multiple Modes**: STDIO (default), MCP(HTTP), SSE; cloud-ready with Nginx proxy

## Installation

### Running with npx

```bash
ANYCRAWL_API_KEY=YOUR-API-KEY npx -y anycrawl-mcp
```

### Manual installation

```bash
npm install -g anycrawl-mcp-server

ANYCRAWL_API_KEY=YOUR-API-KEY anycrawl-mcp
```

## Configuration

AnyCrawl MCP Server supports two deployment modes: **Cloud Service** (recommended) and **Self-Hosted**.

### Cloud Service (Recommended)

Use the AnyCrawl cloud service at `mcp.anycrawl.dev`. No server setup required.

```bash
# Only need your API key
export ANYCRAWL_API_KEY="your-api-key-here"
```

Cloud endpoints:

- **MCP (streamable_http)**: `https://mcp.anycrawl.dev/{API_KEY}/mcp`
- **SSE**: `https://mcp.anycrawl.dev/{API_KEY}/sse`

### Cloud Integration Notes

- Do **not** use the root URL (`https://mcp.anycrawl.dev/`). Always include your API key in the path.
- Replace `{API_KEY}` with your real key. Placeholders like `{YOUR_API_KEY}` are rejected.
- **Cursor remote HTTP** clients should use `/mcp`.
- **Claude Desktop** and SSE clients should use `/sse`.
- API keys in the URL path **must not contain `/`**. URL-encode other special characters when needed.
- SSE clients receive a `/messages?sessionId=...` endpoint. Keep the SSE connection open while posting messages. The messages path does not repeat the API key prefix because the session is already authenticated.
- Invalid API keys are rejected during connection in cloud mode.
- If hosted HTTP/SSE is unstable in your environment, use the stdio fallback:

```json
{
  "mcpServers": {
    "anycrawl": {
      "command": "npx",
      "args": ["-y", "anycrawl-mcp"],
      "env": {
        "ANYCRAWL_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Troubleshooting Cloud MCP

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Root URL shows Nginx welcome page | Using `/` instead of keyed endpoint | Use `/{API_KEY}/mcp` or `/{API_KEY}/sse` |
| `Not Acceptable` on `/mcp` | Missing Accept header | Client must send `Accept: application/json, text/event-stream` |
| MCP connects but tools fail auth | Invalid API key | Verify key in AnyCrawl dashboard |
| Claude Desktop fails after SSE connect | Wrong messages URL or closed SSE stream | Keep SSE open; post to `/messages?sessionId=...` |
| `HEAD /health` fails on old deployments | Upstream did not handle HEAD | Upgrade to latest Docker image |

### Self-Hosted Deployment

For self-hosted deployments, configure the base URL to point to your own AnyCrawl API instance:

```bash
export ANYCRAWL_API_KEY="your-api-key-here"
export ANYCRAWL_BASE_URL="https://your-api-server.com"  # Your self-hosted API URL
```

For local development with custom host/port:

```bash
export ANYCRAWL_HOST="127.0.0.1"  # Default: mcp.anycrawl.dev (cloud)
export ANYCRAWL_PORT="3000"       # Default: 3000
```

### Get your API key

- Visit the AnyCrawl website and sign up or log in: [AnyCrawl](https://anycrawl.dev)
- 🎉 Sign up for free to receive 1,500 credits — enough to crawl nearly 1,500 pages.
- Open the dashboard → API Keys → Copy your key.
- Copy the key and set it as the `ANYCRAWL_API_KEY` environment variable (see above).

## Usage

### Available Modes

AnyCrawl MCP Server supports the following deployment modes:

Default mode is `STDIO` (no env needed). Set `ANYCRAWL_MODE` to switch.

| Mode    | Description                       | Best For                                  | Transport   |
| ------- | --------------------------------- | ----------------------------------------- | ----------- |
| `STDIO` | Standard MCP over stdio (default) | Command-type MCP clients, local tooling   | stdio       |
| `MCP`   | Streamable HTTP (JSON, stateful)  | Cursor (streamable_http), API integration | HTTP + JSON |
| `SSE`   | Server-Sent Events                | Web apps, browser integrations            | HTTP + SSE  |

#### Quick Start Commands

```bash
# Development (local)
npm run dev            # STDIO (default)
npm run dev:mcp          # MCP mode (JSON /mcp)
npm run dev:sse          # SSE mode (/sse)

# Production (built output)
npm start              # STDIO (default)
npm run start:mcp
npm run start:sse

# Env examples
ANYCRAWL_MODE=MCP ANYCRAWL_API_KEY=YOUR-KEY npm run dev:mcp
ANYCRAWL_MODE=SSE ANYCRAWL_API_KEY=YOUR-KEY npm run dev:sse
```

### Docker Compose (MCP + SSE with Nginx)

This repo ships a production-ready image that runs MCP (JSON) on port 3000 and SSE on port 3001 in the same container, fronted by Nginx. Nginx also supports API-key-prefixed paths `/{API_KEY}/mcp` and `/{API_KEY}/sse` and forwards the key via `x-anycrawl-api-key` header.

```bash
docker compose build
docker compose up -d
```

Environment variables used in Docker image:

- `ANYCRAWL_MODE`: `MCP_AND_SSE` (default in compose), or `MCP`, `SSE`
- `ANYCRAWL_MCP_PORT`: default `3000`
- `ANYCRAWL_SSE_PORT`: default `3001`
- `CLOUD_SERVICE`: `true` to extract API key from `/{API_KEY}/...` or headers
- `ANYCRAWL_BASE_URL`: default `https://api.anycrawl.dev`

### Running on Cursor

Configuring Cursor. Note: Requires Cursor v0.45.6+.

For Cursor v0.48.6 and newer, add this to your MCP Servers settings:

```json
{
  "mcpServers": {
    "anycrawl-mcp": {
      "command": "npx",
      "args": ["-y", "anycrawl-mcp"],
      "env": {
        "ANYCRAWL_API_KEY": "YOUR-API-KEY"
      }
    }
  }
}
```

For Cursor v0.45.6:

1. Open Cursor Settings → Features → MCP Servers → "+ Add New MCP Server"
2. Name: "anycrawl-mcp" (or your preferred name)
3. Type: "command"
4. Command:

```bash
env ANYCRAWL_API_KEY=YOUR-API-KEY npx -y anycrawl-mcp
```

On Windows, if you encounter issues:

```bash
cmd /c "set ANYCRAWL_API_KEY=YOUR-API-KEY && npx -y anycrawl-mcp"
```

### Running on VS Code

For manual installation, add this JSON to your User Settings (JSON) in VS Code (Command Palette → Preferences: Open User Settings (JSON)):

```json
{
  "mcp": {
    "inputs": [
      {
        "type": "promptString",
        "id": "apiKey",
        "description": "AnyCrawl API Key",
        "password": true
      }
    ],
    "servers": {
      "anycrawl": {
        "command": "npx",
        "args": ["-y", "anycrawl-mcp"],
        "env": {
          "ANYCRAWL_API_KEY": "${input:apiKey}"
        }
      }
    }
  }
}
```

Optionally, place the following in `.vscode/mcp.json` in your workspace to share config:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "apiKey",
      "description": "AnyCrawl API Key",
      "password": true
    }
  ],
  "servers": {
    "anycrawl": {
      "command": "npx",
      "args": ["-y", "anycrawl-mcp"],
      "env": {
        "ANYCRAWL_API_KEY": "${input:apiKey}"
      }
    }
  }
}
```

### Running on Windsurf

Add this to `~/.codeium/windsurf/model_config.json`:

```json
{
  "mcpServers": {
    "mcp-server-anycrawl": {
      "command": "npx",
      "args": ["-y", "anycrawl-mcp"],
      "env": {
        "ANYCRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Running on Claude Desktop / Claude Code

#### Claude Code (CLI)

Add AnyCrawl MCP server using the `claude mcp add` command:

```bash
claude mcp add --transport stdio anycrawl -e ANYCRAWL_API_KEY=your-api-key -- npx -y anycrawl-mcp
```

#### Claude Desktop

Add this to your Claude Desktop configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "anycrawl": {
      "command": "npx",
      "args": ["-y", "anycrawl-mcp"],
      "env": {
        "ANYCRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Running with SSE Server Mode

The SSE (Server-Sent Events) mode provides a web-based interface for MCP communication, ideal for web applications, testing, and integration with web-based LLM clients.

#### Quick Start

```bash
ANYCRAWL_MODE=SSE ANYCRAWL_API_KEY=YOUR-API-KEY npx -y anycrawl-mcp

# Or using npm scripts
ANYCRAWL_API_KEY=YOUR-API-KEY npm run dev:sse
```

#### Server Configuration

Optional server settings for local/self-hosted deployments:

```bash
export ANYCRAWL_PORT=3000           # Default: 3000
export ANYCRAWL_HOST=127.0.0.1      # Set to override cloud default (mcp.anycrawl.dev)
```

#### Health Check

```bash
curl -s http://localhost:${ANYCRAWL_PORT:-3000}/health
# Response: ok
```

#### Generic MCP/SSE Client Configuration

For other MCP/SSE clients that support SSE transport, use this configuration:

```json
{
  "mcpServers": {
    "anycrawl": {
      "type": "sse",
      "url": "https://mcp.anycrawl.dev/{API_KEY}/sse",
      "name": "AnyCrawl MCP Server",
      "description": "Web scraping and crawling tools"
    }
  }
}
```

or

```json
{
  "mcpServers": {
    "AnyCrawl": {
      "type": "streamable_http",
      "url": "https://mcp.anycrawl.dev/{API_KEY}/mcp"
    }
  }
}
```

**Environment Setup:**

```bash
# Start SSE server with API key
ANYCRAWL_API_KEY=your-api-key-here npm run dev:sse
```

### Cursor configuration for HTTP modes (streamable_http)

Configure Cursor to connect to your HTTP MCP server.

Local HTTP Streamable Server:

```json
{
  "mcpServers": {
    "anycrawl-http-local": {
      "type": "streamable_http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Cloud HTTP Streamable Server:

```json
{
  "mcpServers": {
    "anycrawl-http-cloud": {
      "type": "streamable_http",
      "url": "https://mcp.anycrawl.dev/{API_KEY}/mcp"
    }
  }
}
```

Note: For HTTP modes, set `ANYCRAWL_API_KEY` (and optional host/port) in the server process environment or in the URL. Cursor does not need your API key when using `streamable_http`.

## Available Tools

### 1. Scrape Tool (`anycrawl_scrape`)

Scrape a single URL and extract content in various formats.

**Best for:**

- Extracting content from a single page
- Quick data extraction
- Testing specific URLs

**Parameters:**

- `url` (required): The URL to scrape
- `engine` (optional): Scraping engine (`auto`, `playwright`, `cheerio`, `puppeteer`; default: `auto`)
- `formats` (optional): Output formats (`markdown`, `html`, `text`, `screenshot`, `screenshot@fullPage`, `rawHtml`, `json`)
- `proxy` (optional): Proxy URL
- `timeout` (optional): Timeout in milliseconds (default: 300000)
- `retry` (optional): Whether to retry on failure (default: false)
- `wait_for` (optional): Wait time for page to load
- `include_tags` (optional): HTML tags to include
- `exclude_tags` (optional): HTML tags to exclude
- `json_options` (optional): Options for JSON extraction

**Example:**

```json
{
  "name": "anycrawl_scrape",
  "arguments": {
    "url": "https://example.com",
    "formats": ["markdown", "html"],
    "timeout": 30000
  }
}
```

### 2. Crawl Tool (`anycrawl_crawl`)

Start a crawl job to scrape multiple pages from a website. By default this waits for completion and returns aggregated results using the SDK's `client.crawl` (defaults: poll every 3 seconds, timeout after 60 seconds).

**Best for:**

- Extracting content from multiple related pages
- Comprehensive website analysis
- Bulk data collection

**Parameters:**

- `url` (required): The base URL to crawl
- `engine` (optional): Scraping engine (`auto`, `playwright`, `cheerio`, `puppeteer`; default: `auto`)
- `max_depth` (optional): Maximum crawl depth (default: 10)
- `limit` (optional): Maximum number of pages (default: 100)
- `strategy` (optional): Crawling strategy (`all`, `same-domain`, `same-hostname`, `same-origin`)
- `exclude_paths` (optional): URL patterns to exclude
- `include_paths` (optional): URL patterns to include
- `scrape_options` (optional): Options for individual page scraping
- `poll_seconds` (optional): Poll interval seconds for waiting (default: 3)
- `timeout_ms` (optional): Overall timeout milliseconds for waiting (default: 60000)

**Example:**

```json
{
  "name": "anycrawl_crawl",
  "arguments": {
    "url": "https://example.com/blog",
    "max_depth": 2,
    "limit": 50,
    "strategy": "same-domain",
    "poll_seconds": 3,
    "timeout_ms": 60000
  }
}
```

Returns: `{ "job_id": "...", "status": "completed", "total": N, "completed": N, "creditsUsed": N, "data": [...] }`.

### 3. Crawl Status Tool (`anycrawl_crawl_status`)

Check the status of a crawl job.

**Parameters:**

- `job_id` (required): The crawl job ID

**Example:**

```json
{
  "name": "anycrawl_crawl_status",
  "arguments": {
    "job_id": "7a2e165d-8f81-4be6-9ef7-23222330a396"
  }
}
```

### 4. Crawl Results Tool (`anycrawl_crawl_results`)

Get results from a crawl job.

**Parameters:**

- `job_id` (required): The crawl job ID
- `skip` (optional): Number of results to skip (for pagination)

**Example:**

```json
{
  "name": "anycrawl_crawl_results",
  "arguments": {
    "job_id": "7a2e165d-8f81-4be6-9ef7-23222330a396",
    "skip": 0
  }
}
```

### 5. Cancel Crawl Tool (`anycrawl_cancel_crawl`)

Cancel a pending crawl job.

**Parameters:**

- `job_id` (required): The crawl job ID to cancel

**Example:**

```json
{
  "name": "anycrawl_cancel_crawl",
  "arguments": {
    "job_id": "7a2e165d-8f81-4be6-9ef7-23222330a396"
  }
}
```

### 6. Search Tool (`anycrawl_search`)

Search the web using AnyCrawl search engine.

**Best for:**

- Finding specific information across multiple websites
- Research and discovery
- When you don't know which website has the information

**Parameters:**

- `query` (required): Search query
- `engine` (optional): Search engine (`google`)
- `limit` (optional): Maximum number of results (default: 10)
- `offset` (optional): Number of results to skip (default: 0)
- `pages` (optional): Number of pages to search
- `lang` (optional): Language code
- `country` (optional): Country code
- `scrape_options` (required): Options for scraping search results
- `safeSearch` (optional): Safe search level (0=off, 1=moderate, 2=strict)

**Example:**

```json
{
  "name": "anycrawl_search",
  "arguments": {
    "query": "latest AI research papers 2024",
    "engine": "google",
    "limit": 5,
    "scrape_options": {
      "formats": ["markdown"]
    }
  }
}
```

## Output Formats

### Markdown

Clean, structured markdown content perfect for LLM consumption.

### HTML

Raw HTML content with all formatting preserved.

### Text

Plain text content with minimal formatting.

### Screenshot

Visual screenshot of the page.

### Screenshot@fullPage

Full-page screenshot including content below the fold.

### Raw HTML

Unprocessed HTML content.

### JSON

Structured data extraction using custom schemas.

## Engines

### Auto (Default)

- Automatically selects the best engine for the target URL
- Optimizes for speed and accuracy without manual configuration
- Recommended for most use cases

### Cheerio

- Fast and lightweight
- Good for static content
- Server-side rendering

### Playwright

- Full browser automation
- JavaScript rendering
- Best for dynamic content

### Puppeteer

- Chrome/Chromium automation
- Good balance of features and performance

## Error Handling

The server provides comprehensive error handling:

- **Validation Errors**: Invalid parameters or missing required fields
- **API Errors**: AnyCrawl API errors with detailed messages
- **Network Errors**: Connection and timeout issues
- **Rate Limiting**: Automatic retry with backoff

## Logging

The server includes detailed logging:

- **Debug**: Detailed operation information
- **Info**: General operation status
- **Warn**: Non-critical issues
- **Error**: Critical errors and failures

Set log level with environment variable:

```bash
export LOG_LEVEL=debug  # debug, info, warn, error
```

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
git clone <repository>
cd anycrawl-mcp
npm ci
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

### Lint

```bash
npm run lint
```

### Format

```bash
npm run format
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Run tests: `npm test`
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

- GitHub Issues: [Report bugs or request features](https://github.com/any4ai/anycrawl-mcp-server/issues)
- Documentation: [AnyCrawl API Docs](https://docs.anycrawl.dev)
- Email: help@anycrawl.dev

## About AnyCrawl

AnyCrawl is a powerful Node.js/TypeScript crawler that turns websites into LLM-ready data and extracts structured SERP results from Google/Bing/Baidu/etc. It features native multi-threading for bulk processing and supports multiple output formats.

- **Website**: https://anycrawl.dev
- **GitHub**: https://github.com/any4ai/anycrawl
- **API**: https://api.anycrawl.dev
