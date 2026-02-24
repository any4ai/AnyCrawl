import { SearchEngine, SearchOptions, SearchResult, SearchTask } from "./engines/types.js";
import { GoogleSearchEngine } from "./engines/Google.js";
import { SearxngSearchEngine } from "./engines/Searxng.js";
// @ts-ignore - NodeNext resolution for .js import of TS source
import { ACSearchEngine } from "./engines/ACEngine.js";
import { HttpClient } from "@anycrawl/scrape";
import { log } from "@anycrawl/libs";
import { AVAILABLE_SEARCH_ENGINES } from "@anycrawl/libs/constants";

export interface SearchServiceConfig {
    defaultEngine?: string; // Default search engine name (e.g., 'google', 'searxng')
    enabledEngines?: string[]; // List of enabled engines
    searxngUrl?: string; // SearXNG instance URL
    acEngineUrl?: string; // AC Engine instance URL
}

export class SearchService {
    private engines: Map<string, SearchEngine>;
    private config: SearchServiceConfig;

    constructor(config: SearchServiceConfig = {}) {
        this.engines = new Map();

        // Load config from environment variables with defaults
        this.config = {
            defaultEngine: config.defaultEngine || process.env.ANYCRAWL_SEARCH_DEFAULT_ENGINE,
            enabledEngines: config.enabledEngines || process.env.ANYCRAWL_SEARCH_ENABLED_ENGINES?.split(',').map(e => e.trim()),
            searxngUrl: config.searxngUrl || process.env.ANYCRAWL_SEARXNG_URL,
            acEngineUrl: config.acEngineUrl || process.env.ANYCRAWL_AC_ENGINE_URL,
        };

        log.info(`SearchService initialized with config:`, this.config);

        // Log available engines
        const availableEngines = this.getAvailableEngines();
        log.info(`Available search engines: ${availableEngines.join(', ')}`);

        // Warn if no engines are available
        if (availableEngines.length === 0) {
            log.error('No search engines are available! Please configure at least one engine.');
        }
    }

    /**
     * Get the default engine name (ensures it's available)
     * @returns The default engine name, falling back to first available engine if needed
     */
    getDefaultEngine(): string {
        const requestedDefault = this.config.defaultEngine || 'google';

        // Check if requested default is available
        if (this.isValidEngine(requestedDefault)) {
            return requestedDefault;
        }

        // Fall back to first available engine
        const availableEngines = this.getAvailableEngines();
        if (availableEngines.length === 0) {
            log.error('No search engines are available! Falling back to google (may fail)');
            return 'google';
        }

        const fallbackEngine = availableEngines[0]!;
        log.error(`Configured default engine "${requestedDefault}" is not available, using: ${fallbackEngine}`);
        return fallbackEngine;
    }

    /**
     * Check if engine name is valid and available (based on configuration)
     * @param name - Engine name to check
     * @returns true if engine is valid and has required configuration
     */
    private isValidEngine(name: string): boolean {
        const normalized = name.toLowerCase();

        switch (normalized) {
            case 'google':
                // Google is always available (no special config needed)
                return true;
            case 'searxng':
                // SearXNG requires URL configuration
                return Boolean(this.config.searxngUrl);
            case 'ac-engine':
                // AC Engine requires URL configuration
                return Boolean(this.config.acEngineUrl);
            default:
                return false;
        }
    }

    /**
     * Get list of available engines based on configuration
     * @returns Array of available engine names
     */
    public getAvailableEngines(): string[] {
        const knownEngines = Array.from(AVAILABLE_SEARCH_ENGINES);
        const candidateEngines = (this.config.enabledEngines && this.config.enabledEngines.length > 0)
            ? this.config.enabledEngines.map(e => e.toLowerCase()).filter(e => knownEngines.includes(e as any))
            : knownEngines as string[];
        return candidateEngines.filter(engine => this.isValidEngine(engine));
    }

    /**
     * Resolve engine name - public method for external use
     * @param requestedEngine - The engine name requested (can be undefined, empty, 'default', or invalid)
     * @returns The actual engine name that will be used
     */
    public resolveEngine(requestedEngine?: string): string {
        if (!requestedEngine) {
            return this.getDefaultEngine();
        }
        return this.resolveEngineName(requestedEngine);
    }

    private createEngine(name: string): SearchEngine {
        name = name.toLowerCase();
        switch (name) {
            case "google":
                return new GoogleSearchEngine();
            case "searxng":
                if (!this.config.searxngUrl) {
                    throw new Error(`SearXNG engine is not available: ANYCRAWL_SEARXNG_URL is not configured`);
                }
                return new SearxngSearchEngine(this.config.searxngUrl);
            case "ac-engine":
                if (!this.config.acEngineUrl) {
                    throw new Error(`AC Engine is not available: ANYCRAWL_AC_ENGINE_URL is not configured`);
                }
                return new ACSearchEngine(this.config.acEngineUrl);
            default:
                throw new Error(`Unknown engine type: ${name}`);
        }
    }

    /**
     * Resolve the actual engine name to use based on configuration
     * @param requestedEngine - The engine name requested by the user (can be empty, 'default', or invalid)
     * @returns The actual engine name to use
     */
    private resolveEngineName(requestedEngine: string): string {
        const normalizedEngine = requestedEngine.toLowerCase().trim();

        // If requested engine is empty, 'default', or not available, use default engine
        if (!normalizedEngine || normalizedEngine === 'default' || !this.isValidEngine(normalizedEngine)) {
            const defaultEngine = this.getDefaultEngine();
            if (normalizedEngine && normalizedEngine !== 'default' && normalizedEngine !== '') {
                const reason = !this.isValidEngine(normalizedEngine)
                    ? 'not available (check URL configuration)'
                    : 'invalid';
                log.info(`Engine "${requestedEngine}" is ${reason}, using default: ${defaultEngine}`);
            }
            return defaultEngine;
        }

        // If there's a default engine configured
        if (this.config.defaultEngine) {
            // If enabled engines list exists
            if (this.config.enabledEngines && this.config.enabledEngines.length > 0) {
                // If only one engine is enabled, always use it (ignore requested engine)
                if (this.config.enabledEngines.length === 1) {
                    const singleEngine = this.config.enabledEngines[0]!; // Safe: we just checked length === 1
                    log.info(`Single engine mode: forcing use of ${singleEngine} (requested: ${requestedEngine})`);
                    return singleEngine;
                }

                // Multiple engines enabled: use requested if it's in the enabled list, otherwise use default
                if (this.config.enabledEngines.includes(normalizedEngine)) {
                    return normalizedEngine;
                } else {
                    log.info(`Requested engine ${requestedEngine} not in enabled list, using default: ${this.config.defaultEngine}`);
                    return this.config.defaultEngine.toLowerCase();
                }
            }
        }

        // Use the validated requested engine
        return normalizedEngine;
    }

    getEngine(name: string): SearchEngine {
        const actualName = this.resolveEngineName(name);
        let engine = this.engines.get(actualName);
        if (!engine) {
            engine = this.createEngine(actualName);
            this.engines.set(actualName, engine);
        }
        return engine;
    }

    /**
     * Execute search using HttpClient
     * @param engineName - The search engine name (optional, uses default if not provided)
     * @param options - Search options
     * @param onPage - Optional callback for each page of results
     * @returns Promise resolving to search results
     */
    async search(
        engineName: string | undefined,
        options: SearchOptions,
        onPage?: (page: number, results: SearchResult[], uniqueKey: string, success: boolean) => void,
    ): Promise<SearchResult[]> {
        log.info("Search called with options:", options);

        try {
            // Use default engine if none provided
            const actualEngineName = engineName || this.config.defaultEngine || 'default';
            const engine = this.getEngine(actualEngineName);
            const allResults: SearchResult[] = [];

            // Determine effective pages
            const perPage = 10; // Default page size per request for engines that do not support direct limit
            let effectivePages = options.pages ?? 1;
            if (typeof options.limit === 'number' && options.limit > 0) {
                // If engine supports direct limit, one request is enough
                if ((engine as any).supportsDirectLimit) {
                    effectivePages = 1;
                } else {
                    effectivePages = Math.ceil(options.limit / perPage);
                }
            }

            log.info(`Executing search for: ${actualEngineName}, pages: ${effectivePages}, concurrent: ${options.concurrent ?? false}`);

            // Helper function to fetch a single page
            const fetchPage = async (pageNum: number): Promise<{ pageNum: number; results: SearchResult[]; success: boolean }> => {
                try {
                    // Build task options
                    const taskOptions: any = { ...options, page: pageNum };
                    if (typeof options.limit === 'number' && options.limit > 0) {
                        // If engine does not support direct limit, enforce per-page limit
                        if (!(engine as any).supportsDirectLimit) {
                            taskOptions.limit = perPage;
                        }
                    }
                    const task: SearchTask = await engine.search(taskOptions);

                    log.info(`Fetching page ${pageNum}: ${task.url} requireProxy=${task.requireProxy}`);

                    // Prepare cookie header if cookies are present
                    const cookieHeader = task.cookies && Object.keys(task.cookies).length > 0
                        ? Object.entries(task.cookies).map(([key, value]) => `${key}=${value}`).join('; ')
                        : undefined;

                    // Make HTTP request using HttpClient
                    const response = await HttpClient.get(task.url, {
                        headers: task.headers,
                        cookieHeader: cookieHeader,
                        requireProxy: task.requireProxy === true,
                        timeoutMs: 30000,
                        retries: 2,
                    });

                    // Parse the response
                    const html = response.rawText || response.data;
                    const results = await engine.parse(html, { url: task.url, page: pageNum });

                    log.info(`Page ${pageNum} returned ${results.length} results`);

                    return { pageNum, results, success: true };
                } catch (error) {
                    log.error(`Error fetching page ${pageNum}: ${error}`);
                    return { pageNum, results: [], success: false };
                }
            };

            // Execute requests - concurrent or sequential based on options
            if (options.concurrent) {
                // Concurrent: fetch all pages in parallel
                const pageNumbers = Array.from({ length: effectivePages }, (_, i) => i + 1);
                const pageResults = await Promise.all(pageNumbers.map(fetchPage));

                // Sort by page number and accumulate results
                pageResults.sort((a, b) => a.pageNum - b.pageNum);
                for (const { pageNum, results, success } of pageResults) {
                    if (onPage) {
                        onPage(pageNum, results, actualEngineName, success);
                    }
                    allResults.push(...results);
                }
            } else {
                // Sequential: fetch pages one by one
                for (let i = 0; i < effectivePages; i++) {
                    const pageNum = i + 1;
                    const { results, success } = await fetchPage(pageNum);

                    if (onPage) {
                        onPage(pageNum, results, actualEngineName, success);
                    }
                    allResults.push(...results);
                }
            }

            // Apply limit if specified
            const finalResults = typeof options.limit === 'number' && options.limit > 0
                ? allResults.slice(0, options.limit)
                : allResults;

            log.info(`Search completed: ${finalResults.length} total results`);
            return finalResults;

        } catch (error) {
            log.error(`Search execution error: ${error}`);
            return [];
        }
    }

}
