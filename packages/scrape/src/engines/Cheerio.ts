import { BaseEngine, BaseEngineType } from "./Base.js";
import type { EngineOptions, CrawlingContext } from "../types/engine.js";
import { CheerioCrawler, CheerioCrawlingContext, Dictionary, Dataset } from "crawlee";
import { log } from "@anycrawl/libs";

/**
 * CheerioEngine class for web scraping using Cheerio
 * A lightweight implementation for parsing and extracting data from HTML
 */
export class CheerioEngine extends BaseEngine {
    protected engine: CheerioCrawler | null = null;
    protected isInitialized: boolean = false;
    protected customRequestHandler?: (context: CrawlingContext) => Promise<any> | void;
    protected customFailedRequestHandler?: (
        context: CrawlingContext,
        error: Error
    ) => Promise<any> | void;

    /**
     * Constructor for CheerioEngine
     * @param options Optional configuration options for the engine
     */
    constructor(options: EngineOptions = {}) {
        super(options);
        this.customRequestHandler = options.requestHandler;
        this.customFailedRequestHandler = options.failedRequestHandler;
    }

    /**
     * Initialize the crawler engine
     */
    async init(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        if (!this.queue) {
            throw new Error("Request queue not set for Cheerio engine");
        }

        // Create common handlers
        const { requestHandler, failedRequestHandler } = this.createCommonHandlers(
            this.customRequestHandler,
            this.customFailedRequestHandler
        );

        const crawlerOptions = {
            ...this.options,
            requestHandler,
            failedRequestHandler,
        };

        // Apply engine-specific configurations (CheerioEngine is not a browser engine)
        const enhancedOptions = this.applyEngineConfigurations(crawlerOptions, BaseEngineType.CHEERIO);

        this.engine = new CheerioCrawler(enhancedOptions);
        this.isInitialized = true;
    }

    /**
     * Get the underlying CheerioCrawler instance
     * @returns The CheerioCrawler instance
     */
    getEngine(): CheerioCrawler {
        if (!this.engine) {
            throw new Error("Engine not initialized. Call init() first.");
        }
        return this.engine;
    }
}
