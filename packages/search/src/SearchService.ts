import { SearchEngine, SearchOptions, SearchResult, SearchTask } from "./engines/types.js";
import { GoogleSearchEngine } from "./engines/Google.js";
import { Utils, CrawlingContext, Engine, EngineFactoryRegistry } from "@anycrawl/scrape";
import { randomUUID } from "node:crypto";
import { log } from "@anycrawl/libs";

export class SearchService {
    private engines: Map<string, SearchEngine>;
    private requestsToResponses: Map<string, (results: SearchResult[]) => void>;
    private partialResults: Map<string, SearchResult[]>;
    private pendingRequests: Map<string, number>;
    private crawler: Engine | null = null;
    private searchQueue: any | null = null;
    private requestsToOnPage: Map<string, (page: number, results: SearchResult[], uniqueKey: string, success: boolean) => void>;
    private requestsToLimit: Map<string, number | undefined>;

    constructor() {
        this.engines = new Map();
        this.requestsToResponses = new Map();
        this.partialResults = new Map();
        this.pendingRequests = new Map();
        this.requestsToOnPage = new Map();
        this.requestsToLimit = new Map();
    }

    private createEngine(name: string): SearchEngine {
        name = name.toLowerCase();
        switch (name) {
            case "google":
                return new GoogleSearchEngine();
            default:
                throw new Error(`Unknown engine type: ${name}`);
        }
    }

    getEngine(name: string): SearchEngine {
        let engine = this.engines.get(name);
        if (!engine) {
            engine = this.createEngine(name);
            this.engines.set(name, engine);
        }
        return engine;
    }

    /**
     * Initialize the crawler
     * @returns {Promise<void>}
     */
    public async initializeCrawler() {
        if (!this.crawler) {
            log.info("Initializing crawler...");
            this.searchQueue = await Utils.getInstance().getQueue("AnyCrawl_Search");
            this.crawler = await EngineFactoryRegistry.createEngine('cheerio',
                this.searchQueue,
                {
                    keepAlive: true,
                    requestHandler: async (context: CrawlingContext) => {
                        log.info(`Request handler called for: ${context.request.url}`);
                        try {
                            const { request, body } = context as { request: any; body: Buffer };
                            const html = body.toString("utf-8");
                            log.info(`HTML content: ${html.substring(0, 200)}...`);
                            const uniqueKey = request.userData.uniqueKey;
                            log.info(`Processing request with uniqueKey: ${uniqueKey}`);

                            const engine = this.getEngine(request.userData.engineName);
                            log.info(`HTML content length: ${html.length}`);

                            const results = await engine.parse(html, request);
                            log.info(`Parsed results: ${results.length}`);

                            const pageNumber = request.userData.page ?? 1;

                            // Per-page callback
                            const onPageCb = this.requestsToOnPage.get(uniqueKey);
                            if (onPageCb) onPageCb(pageNumber, results, uniqueKey, true);

                            // Accumulate results
                            const currentResults = this.partialResults.get(uniqueKey) || [];
                            this.partialResults.set(uniqueKey, [...currentResults, ...results]);

                            // Decrement pending requests
                            const pendingCount = this.pendingRequests.get(uniqueKey) || 0;
                            const newPendingCount = pendingCount - 1;
                            this.pendingRequests.set(uniqueKey, newPendingCount);

                            // If all requests are complete, resolve with accumulated results
                            if (newPendingCount === 0) {
                                const callback = this.requestsToResponses.get(uniqueKey);
                                if (callback) {
                                    log.info(`All requests complete for uniqueKey: ${uniqueKey}`);
                                    const limit = this.requestsToLimit.get(uniqueKey);
                                    const aggregated = this.partialResults.get(uniqueKey) || [];
                                    const finalResults = typeof limit === 'number' && limit > 0
                                        ? aggregated.slice(0, limit)
                                        : aggregated;
                                    callback(finalResults);
                                    this.requestsToResponses.delete(uniqueKey);
                                    this.partialResults.delete(uniqueKey);
                                    this.pendingRequests.delete(uniqueKey);
                                    this.requestsToOnPage.delete(uniqueKey);
                                    this.requestsToLimit.delete(uniqueKey);
                                }
                            }
                        } catch (error) {
                            log.error(`Error in request handler: ${error}`);
                            throw error;
                        }
                    },
                    failedRequestHandler: async (context: CrawlingContext) => {
                        log.info(`Failed request handler called for: ${context.request.url}`);
                        try {
                            const { request, error } = context as any;
                            const uniqueKey = request.userData.uniqueKey;
                            log.error(`Failed to process ${request.url}:`, error);

                            const pageNumber = request.userData.page ?? 1;

                            // Per-page callback (failure)
                            const onPageCb = this.requestsToOnPage.get(uniqueKey);
                            if (onPageCb) onPageCb(pageNumber, [], uniqueKey, false);

                            // Decrement pending requests even for failed requests
                            const pendingCount = this.pendingRequests.get(uniqueKey) || 0;
                            const newPendingCount = pendingCount - 1;
                            this.pendingRequests.set(uniqueKey, newPendingCount);

                            // If all requests are complete (including failed ones), resolve with accumulated results
                            if (newPendingCount === 0) {
                                const callback = this.requestsToResponses.get(uniqueKey);
                                if (callback) {
                                    log.info(
                                        `All requests complete for uniqueKey: ${uniqueKey} (including failed ones)`
                                    );
                                    const limit = this.requestsToLimit.get(uniqueKey);
                                    const aggregated = this.partialResults.get(uniqueKey) || [];
                                    const finalResults = typeof limit === 'number' && limit > 0
                                        ? aggregated.slice(0, limit)
                                        : aggregated;
                                    callback(finalResults);
                                    this.requestsToResponses.delete(uniqueKey);
                                    this.partialResults.delete(uniqueKey);
                                    this.pendingRequests.delete(uniqueKey);
                                    this.requestsToOnPage.delete(uniqueKey);
                                    this.requestsToLimit.delete(uniqueKey);
                                }
                            }
                        } catch (error) {
                            log.error(`Error in failed request handler: ${error}`);
                        }
                    },
                    additionalMimeTypes: ["text/html", "text/plain"],
                }
            );
            log.info("Crawler initialized");
            await this.crawler.init();
            log.info("Crawler init completed");
        }
    }

    async search(
        engineName: string,
        options: SearchOptions,
        onPage?: (page: number, results: SearchResult[], uniqueKey: string, success: boolean) => void,
    ): Promise<SearchResult[]> {
        log.info("Search called with options:", options);
        return new Promise(async (resolve) => {
            const uniqueKey = randomUUID();
            log.info(`Created uniqueKey for search: ${uniqueKey}`);
            this.requestsToResponses.set(uniqueKey, resolve);
            this.partialResults.set(uniqueKey, []);
            // Determine effective pages based on limit if provided
            let effectivePages = options.pages ?? 1;
            if (typeof options.limit === 'number' && options.limit > 0) {
                const perPage = 10; // Google default page size
                effectivePages = Math.ceil(options.limit / perPage);
                this.requestsToLimit.set(uniqueKey, options.limit);
            } else {
                this.requestsToLimit.set(uniqueKey, undefined);
            }
            this.pendingRequests.set(uniqueKey, effectivePages);
            if (onPage) this.requestsToOnPage.set(uniqueKey, onPage);

            await this.executeSearch(engineName, { ...options, pages: effectivePages }, uniqueKey);
        });
    }

    private async executeSearch(
        engineName: string,
        options: SearchOptions,
        uniqueKey: string
    ): Promise<void> {
        try {
            log.info(`Executing search for: ${engineName} ${JSON.stringify(options)}`);

            const engine = this.getEngine(engineName);
            const tasks: SearchTask[] = [];
            // account for pages to be added to the queue
            for (let i = 0; i < (options.pages ?? 1); i++) {
                tasks.push(
                    await engine.search({
                        ...options,
                        page: i + 1,
                    })
                );
            }
            log.info(`Tasks: ${JSON.stringify(tasks)}`);
            log.info(`Got request data: ${tasks.length} requests`);

            if (!this.searchQueue) {
                throw new Error("Search queue not initialized");
            }

            // Add requests to the queue
            for (const request of tasks) {
                log.info(`Adding request to queue: ${request.url}`);
                await this.searchQueue.addRequest({
                    url: request.url,
                    userData: {
                        ...request,
                        uniqueKey,
                        engineName,
                        queueName: "AnyCrawl_Search",
                        options: {}
                    },
                    uniqueKey: randomUUID(),
                });
            }

            // Always start the crawler
            if (this.crawler) {
                log.info("Starting crawler...");
                const crawlerEngine = this.crawler.getEngine();
                if (!crawlerEngine.running) {
                    await crawlerEngine.run();
                    log.info("Crawler started");
                } else {
                    log.info("Crawler already running");
                }
            } else {
                throw new Error("Crawler not initialized");
            }
        } catch (error) {
            log.error(`Search execution error: ${error}`);
            const callback = this.requestsToResponses.get(uniqueKey);
            if (callback) {
                callback([]);
                this.requestsToResponses.delete(uniqueKey);
            }
        }
    }

}
