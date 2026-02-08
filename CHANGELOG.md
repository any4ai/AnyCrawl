# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.13] - 2026-02-08

### Added

- Page cache (S3-backed) and map cache (DB-backed) with cache controls (`max_age`, `store_in_cache`, `use_index`) across scrape/crawl/map plus cache hit tracking
- Map API for website URL discovery/extraction (with default search engine discovery behavior)
- `links` output format to extract all URLs from scraped pages (scrape/crawl/search)
- `summary` output format for content summarization
- Comprehensive webhook events for scrape/crawl/search/map and scheduled task execution cancel endpoint with enhanced execution metrics
- Subscription tiers with scheduled task limits and credit estimation
- JS SDK support for the Map API

### Changed

- HTML to Markdown conversion improvements (GFM support, smart main-content extraction, lazy-loaded images, section support)
- URL extraction now uses Crawlee implementation

### Fixed

- Search credits calculation now accounts for page count
- Cache key parameter handling in caching layer
- Docs metadata generation when page description is missing

## [1.0.0-beta.12] - 2026-01-31

### Added

- Proxy modes (`auto`/`base`/`stealth`) with centralized credit calculation
- Session rotation option to rotate after every error in engine configurator
- MCP setup guides and improved SEO with structured data

### Changed

- Enhanced scheduled tasks with credit estimation and validation
- Improved queue handling in Worker with detailed logging for Webhook and Scheduler managers

### Fixed

- Task schema now allows nullable description and max executions per day

## [1.0.0-beta.11] - 2026-01-28

### Added

- Template task type support for scheduled tasks, allowing dynamic engine selection based on template configuration

## [1.0.0-beta.10] - 2026-01-28

### Added

- Webhook and Scheduler managers with support for scheduled tasks and webhook events
- Network traffic tracking for jobs
- IP address whitelisting for API keys, enhancing security by allowing only specified IPs to access the API

### Changed

- Enhanced proxy handling with `original_url` for improved rule matching and session management during retries
- Updated Next.js and related dependencies to version 15.3.6

### Fixed

- Standardized JSON key naming conventions in API responses for consistency
- Updated import paths to include `.js` extension for serializer utility

## [1.0.0-beta.9] - 2025-11-21

### Added

- `scrape_paths` parameter for selective content extraction in crawl API, allowing users to specify which URLs to scrape while still discovering links from included paths

### Fixed

- Updated minimatch import to named import for consistency

## [1.0.0-beta.8] - 2025-10-22

### Added

- Domain restriction validation for templates with glob and exact pattern matching support
- Pre-navigation API for browser-based templates with HTML content resolution from multiple sources
- Environment variable `ANYCRAWL_TEMPLATE_CACHE_TTL_MS` for controlling template cache behavior (set to 0 to disable cache)

### Changed

- Enhanced template cache to support TTL-based disabling (TTL=0 disables caching completely)
- Template sandbox now provides secure page proxy with whitelisted methods for Playwright/Puppeteer

### Fixed

- Template validation cache now correctly invalidates in development mode to improve developer experience

## [1.0.0-beta.6] - 2025-10-16

### Added

- Env-driven config (`ANYCRAWL_SEARCH_DEFAULT_ENGINE`, `ANYCRAWL_SEARCH_ENABLED_ENGINES`, `ANYCRAWL_SEARXNG_URL`, `ANYCRAWL_AC_ENGINE_URL`) for `SearchService`
- New search engines: `SearXNG`, `AC-Engine`

### Fixed

- Graceful fallback when requested engine is invalid or unavailable (use configured default)
- Safer error handling/logging for per-page fetch/parse to avoid failing entire request
- Parsing guards for `AC-Engine` and `SearXNG` to return empty results on malformed responses

## [1.0.0-beta.5] - 2025-10-14

### Added

- Introduced template rendering utilities `renderUrlTemplate` and `renderTextTemplate` with filter support (`raw`, `query`, `path`, `host`) and placeholder escaping

### Changed

- `SearchController`: render `query` from template variables; enrich search results with scrape data and prefix screenshot paths with public domain route
- Improved job progress accounting to include scrape tasks; refined credit calculation to include JSON extraction credits and template per-call price
- Logging: safer response header serialization and tolerant JSON parsing in `LogMiddleware`; skip `/health`

## [1.0.0-beta.3] - 2025-10-12

### Changed

- Can disable template cache during developing

### Fixed

- fixed Dockerfilr for generating api.

## [1.0.0-beta.2] - 2025-10-12

### Fixed

- Try to fix command for generating api during docker container.

## [1.0.0-beta.1] - 2025-10-11

### Added

- Template system with validation, execution, trusted flag, and caching; includes new database schema for templates and template executions
- Template integration across `CrawlController`, `ScrapeController`, and `SearchController`, including template variables support and request data merging
- Template field validation in controllers to ensure only allowed fields are used with `template_id`
- Template documentation and OpenAPI template schema; examples and usage guidelines for API integration
- Base Jest configuration for the monorepo with ESM support and shared settings; added JSON schema validation tests
- Search locale mapping for unsupported languages to improve tokenizer support in Orama
- Worker periodic cleanup for expired pending jobs
- New environment variables for template execution and request handler timeouts; engines updated to consume them
- HTML→Markdown enhancements: linked image handling, `figure`/`picture` normalization, `figcaption` support, and post-processing cleanup
- CLI: add `key:generate` command to generate API keys

### Changed

- Standardized naming conventions across API/Search to use `safe_search` in place of `safeSearch`
- Refactored constants into a dedicated module; reorganized dependency usage across `@anycrawl/libs`, `@anycrawl/scrape`, and `@anycrawl/search`
- Improved template permission checks to validate user access based on ownership and status
- Enhanced schemas and validation logic to support template features and variables
- Proxy behavior adjustments in `newProxyInfo` to allow null URLs and safer fallbacks; minor type refinements (e.g., `attachFile` cast)

### Fixed

- `@anycrawl/js-sdk`: avoid throwing on cancelled crawls to improve control flow during job execution

## [0.0.1] - 2025-09-14

### Added

- `@anycrawl/js-sdk` client for scraping, crawling, and search with axios integration, logging, and Jest tests
- OpenAPI schema support for `extract_source` in JSON extraction
- Controllers updated to support customizable `extract_source`; improved credit calculation and logging for HTML/Markdown formats

## [0.0.1-beta.18] - 2025-09-06

### Added

- Customizable scrape options in `SearchController`/`SearchService`, including limit handling and URL enrichment
- Request configuration enhancements in `EngineConfigurator` (timeout and navigation options)

## [0.0.1-beta.17] - 2025-09-03

### Added

- Enforced `limit`/`offset` constraints in `SearchController`/`SearchSchema`
- Periodic logging for browser engine status and configuration visibility for authentication and credits
- Docker build tools for native modules; ensured `better-sqlite3` rebuilds in Docker images

### Changed

- Improved error handling in body parsing and server timeouts
- Finalize crawl jobs on extraction errors in `BaseEngine` to improve completion tracking

## [0.0.1-beta.16] - 2025-09-02

### Added

- Startup logging for authentication and credits configuration

### Fixed

- Credit deduction transaction handling to ensure atomic updates; refined remaining credits logging

## [0.0.1-beta.15] - 2025-09-01

### Changed

- Added enqueuing state tracking in `BaseEngine`/`ProgressManager`, improved job finalization logic, and enqueue error handling

## [0.0.1-beta.14] - 2025-08-30

### Added

- Periodic finalization checks for crawl jobs based on limits with improved trace logging

### Fixed

- `ScreenshotTransformer` now includes unique request identifiers in filenames to prevent duplication

## [0.0.1-beta.13] - 2025-08-29

### Changed

- Improved `DeductCreditsMiddleware` credit deduction logic with route checks and better traceability

### Fixed

- Mark jobs as failed if no pages are successfully processed in `ProgressManager`

## [0.0.1-beta.12] - 2025-08-28

### Added

- Applied common hooks across all engines in `EngineConfigurator`
- Integrated `ProgressManager` in `CrawlController` to handle job cancellation and finalize flags

### Changed

- Enhanced debug logging in `EngineConfigurator` and set development log level
- Refined insufficient credits response in `CrawlController` to include a clear message field
- Documentation: added X.com badge to README

## [0.0.1-beta.11] - 2025-08-28

### Changed

- `CrawlController` insufficient credits response now provides current credits for clarity

## [0.0.1-beta.10] - 2025-08-28

### Added

- Credit validation in `CrawlController` to ensure users have sufficient credits for requested crawl limits

### Changed

- Enhanced `DeductCreditsMiddleware` for asynchronous credit deduction and improved transaction handling in `ProgressManager`

## [0.0.1-beta.9] - 2025-08-26

### Added

- Introduced `CrawlLimitReachedError` and a limit filter hook in `EngineConfigurator`; updated `ProgressManager` for limit-based credit handling

### Changed

- Improved progress checks in `BaseEngine`/`ProgressManager` to prevent navigation/request handling when limits are reached or jobs are cancelled
- Documentation updates in README

## [0.0.1-beta.8] - 2025-08-25

### Fixed

- Fixed credit deduction logic in ProgressManager to ensure credits are only deducted on successful scrapes, improving error handling and credit management

## [0.0.1-beta.7] - 2025-08-25

### Fixed

- Updated screenshot handling in ScrapeController and DataExtractor to fix full-page screenshots with proper path handling
- Fixed credit deduction to ensure no credits are deducted for failed scrapes, validation errors, and internal errors in ScrapeController

## [0.0.1-beta.6] - 2025-08-24

### Added

- Enhanced job management in ScrapeController and SearchController with improved status tracking
- Implemented per-page result handling and logging for job status updates in SearchService
- Added screenshot path prefixing with public domain route in CrawlController for improved URL handling

## [0.0.1-beta.5] - 2025-08-18

### Added

- Enhanced JSON extraction logic by ensuring formats include JSON in ScrapeController, DataExtractor, and ProgressManager
- Updated data mapping in CrawlController to include URL in results for enhanced data structure and better result organization

## [0.0.1-beta.4] - 2025-08-18

### Changed

- Added utility module exports in package.json for better package organization
- Introduced job type constants in constants.ts for improved type safety and consistency
- Enhanced dynamic import handling for engine management and cleaned up unused imports in Worker.ts

## [0.0.1-beta.3] - 2025-08-17

### Changed

- Enhanced AI configuration management by introducing async loading and caching capabilities
- Updated LLMExtract tests to utilize new config methods for better testing coverage
- Added comprehensive logging for AI config status and provider validation

### Changed

- Improved Docker image versioning by removing hardcoded GITHUB_TAG and updating tag extraction method in docker-image.yml

## [0.0.1-beta.2] - 2025-08-17

### Added

- Added new configuration variable for JSON extraction credit management in .env.example

### Changed

- Enhanced credit deduction logic for structured extraction with support for JSON extraction credits
- Updated project documentation with improved README.md structure and clarity
- Enhanced LLM extraction section with better parameter descriptions and usage examples
- Improved project overview and usage documentation for better developer experience

## [0.0.1-beta.1] - 2025-08-16

### Added

- Comprehensive job management system with job creation, status tracking, and results handling
- LLM-powered JSON schema extraction capabilities with enhanced extraction prompts
- ai-sdk framework with support for OpenRouter, OpenAI, and OpenAI-compatible providers
- ProgressManager for real-time crawl job progress monitoring
- Added crawl API endpoints with job management

### Changed

- Extracted database logic from API package into new `@anycrawl/db` package for better separation of concerns
- Updated zod to version 3.25.76 across all packages for improved type safety
- Refactored database access patterns to use the new dedicated database package
- Refactored job completion and failure logic with improved error handling and status updates
- Enhanced ALL-in-ONE Dockerfile and API Dockerfile for better deployment experience
- Reorganized documentation structure with improved meta.json organization and proxy rule documentation
- Enhanced proxy configuration loading with support for both file and HTTP URL sources

### Fixed

- Enhanced proxy selection logic for improved fallback handling

## [0.0.1-alpha.8] - 2025-07-04

### Added

- Advanced proxy configuration options including URL-based routing and tiered proxy management
- Multi-architecture Docker build support for ALL-IN-ONE with architecture detection and GitHub Actions workflow for automated image building and pushing
- AI provider management module with configuration, model mapping, and cost tracking features
- LLMExtract agent for structured-data extraction with enhanced model interaction capabilities (next version will support etraction in scrape)
- Performance testing script with K6 for load testing with metrics and scenarios
- Fingerprinting options for Puppeteer and Playwright configurations for using newer version Chrome
- Enhanced Docker documentation with quick start guide and Arm64 architecture support

### Changed

- Enhanced HTML to Markdown conversion with custom rules for whitespace, divs, spans, emphasis, and line breaks
- Improved scraping functionality with enhanced error handling and refined response structure
- Updated project configuration and dependencies, including knip configuration and improved dependency management
- Refactored proxy configuration by extending Crawlee's ProxyConfiguration for simplified management
- Improved null safety in DataExtractor by using optional chaining for userData properties
- Updated scripts for improved development workflow with type checking

### Fixed

- Improved error logging in EngineConfigurator for better debugging
- Enhanced icon rendering logic to handle undefined cases and ensure proper component type handling
- Improved helper function getEnabledModelIdByModelKey for better reliability
- Handle 403 Forbidden responses in BaseEngine to improve error management
- Fixed Docker image tagging logic in GitHub Actions workflows

## [0.0.1-alpha.7] - 2025-06-17

### Added

- Created separate public router for public endpoints like file serving, improving API organization

### Changed

- Significantly enhanced `HTMLTransformer` with automatic relative URL transformation for images, links, and other resources
- Enhanced `srcset` attribute handling for responsive images with size and pixel density parsing
- Improved anchor href transformation with robust URL resolution
- Refactored API routing architecture by splitting routes into dedicated modules for better separation of concerns
- Enhanced `DataExtractor` with new `TransformOptions` interface supporting base URL specification and URL transformation toggles
- Updated screenshot path handling in `ScrapeController` for improved organization and clarity

## [0.0.1-alpha.6] - 2025-06-15

### Changed

- Improved flexibility in S3 integration.

### Fixed

- Streamlined job payload structure in `ScrapeController` by transforming validated request data.
- Updated `ScrapeSchema` to encapsulate options within a single object for improved clarity and maintainability.

## [0.0.1-alpha.6.2] - 2025-06-17

### Changed

- Restructured API routing: created a dedicated public router and updated screenshot path handling in `ScrapeController` for clarity

### Chore

- Updated changelog for version 0.0.1-alpha.6.2

## [0.0.1-alpha.6.1] - 2025-06-16

### Chore

- Incremented `GITHUB_TAG` to `v0.0.1-alpha.6.1` in Docker image workflows

## [0.0.1-alpha.5] - 2025-06-14

### Added

- Integrated AWS S3 storage support with new `S3` class and environment variables for seamless file uploads and retrievals.
- Introduced `FileController` for serving files from S3 or local storage with robust path validation and error handling.
- Added multiple content transformers (Screenshot, `HTMLTransformer`) improving HTML/Markdown extraction and screenshot generation.
- Extended scraping capabilities with new options: output `formats`, `timeout`, tag filtering, `wait_for`, retry strategy, viewport configuration, and custom user-agent support.
- Added Safe Search parameter to `SearchSchema` for filtered search results.
- Refactored engine architecture with a factory pattern and new core modules for configuration validation, data extraction, and job management.
- Implemented graceful shutdown handling for the API server and improved logging for uncaught exceptions / unhandled rejections.
- Added Jest configuration for API and library packages with ESM support and updated test scripts.
- Updated CI workflows to publish Docker images on version tags.
- Expanded README with detailed environment variable descriptions and API usage examples.

### Changed

- Refined error handling in `ScrapeController` and `JobManager`; failure responses now include structured error objects and HTTP status codes.
- Enhanced `BaseEngine` with explicit HTTP error checks and resilience improvements.
- Updated OpenAPI documentation to reflect new scraping parameters and error formats.
- Migrated key-value store name to environment configuration for greater flexibility.
- Enhanced per-request credit tracking in `ScrapeController` and enhanced logging middleware to include credit usage.

### Fixed

- Improved job failure messages to include detailed error data, ensuring clearer debugging information.
- Minor documentation corrections and clarifications.

## [0.0.1-alpha.4] - 2025-05-26

### Changed

- Modified parameters of engines.

### Fixed

- Fixed Dockerfile.puppeteer errors.

## [0.0.1-alpha.3] - 2025-05-25

### Added

- Added comprehensive OpenAPI documentation generation with automated API endpoint documentation
- Added credits system with real-time credit tracking and management
- Added `DeductCreditsMiddleware` for automatic credit deduction on successful API requests
- Added new database fields for user tracking and enhanced request logging, and dropped some columns.
- Added Docker deployment guide and documentation

### Changed

- Enhanced error handling in `ScrapeController` to return structured error messages array
- Updated `SearchSchema` to enforce minimum (1) and maximum (20) values for pages parameter
- Refactored `CheckCreditsMiddleware` to fetch user credits from database in real-time
- Updated PostgreSQL and SQLite schemas for `api_key` and `request_log` tables with new user field
- Enhanced logging middleware to capture additional request details including response body
- Updated README with usage instructions and documentation links
- Improved credit deduction logic to allow negative credits and atomic updates
- Enhanced API endpoints with structured responses and better validation
- Imporved request logging middleware to capture detailed request/response information

### Fixed

- Fixed database schema consistency between PostgreSQL and SQLite
- Improved error handling and logging across API controllers

## [0.0.1-alpha.2] - 2025-05-15

### Added

- Added proxy support to scraping configuration
- Added ANYCRAWL_KEEPALIVE option for engine keep-alive functionality

### Changed

- Updated Dockerfiles for Cheerio, Playwright, and Puppeteer services
- Improved Docker environment variables configuration
- Modified Docker permissions and directory ownership settings
- Updated .env.example and docker-compose.yml to use ANYCRAWL_REDIS_URL

### Fixed

- Fixed Docker permissions issues for scraping services
- Fixed database migration issues

## [0.0.1-alpha.1] - 2025-05-13

### Added

- Initial project setup with a monorepo structure using pnpm workspaces
- Docker support for easy deployment and environment consistency
    - Provided `Dockerfile` and `docker-compose.yml`
- Node.js environment requirements (>=18)
- Package management with pnpm 10.10.0
- Core web crawling functionality:
    - Single page content extraction
    - Multi-threading and multi-process architecture for high performance
- SERP (Search Engine Results Page) crawling:
    - Support for Google search engine
    - Batch processing (multiple pages per request)
- Development environment setup:
    - TypeScript configuration
    - Prettier code formatting
    - Turbo repo configuration for monorepo management
- Documentation:
    - Project overview and feature list in README
    - Contributing guidelines
    - MIT License

### Technical Details

- Built with Node.js and TypeScript
- Redis integration for caching and queue management
- JavaScript rendering support via Puppeteer and Playwright
- HTTP crawling via Cheerio

**This is the initial release.**
