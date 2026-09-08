import { BaseEngine, BaseEngineType } from "./Base.js";
import { config } from "@anycrawl/libs";
import { StickyPlaywrightCrawler } from "./StickyBrowserCrawler.js";
import type { EngineOptions, CrawlingContext } from "../types/engine.js";
import {
    Dictionary,
    PlaywrightCrawler,
    PlaywrightCrawlingContext,
} from "crawlee";

export class PlaywrightEngine extends BaseEngine {
    protected engine: PlaywrightCrawler | null = null;
    protected isInitialized: boolean = false;
    protected customRequestHandler?: (
        context: CrawlingContext
    ) => Promise<any> | void;
    protected customFailedRequestHandler?: (context: CrawlingContext, error: Error) => Promise<any> | void;

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
            throw new Error("Request queue not set for Playwright engine");
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

        // Apply engine-specific configurations (including ad blocking for browser engines)
        const enhancedOptions = this.applyEngineConfigurations(crawlerOptions, BaseEngineType.PLAYWRIGHT);

        this.engine = config.proxy.stickyEnabled
            ? new StickyPlaywrightCrawler(enhancedOptions)
            : new PlaywrightCrawler(enhancedOptions);
        this.isInitialized = true;
    }

    /**
     * Get the underlying PlaywrightCrawler instance
     * @returns The PlaywrightCrawler instance
     */
    getEngine(): PlaywrightCrawler {
        if (!this.engine) {
            throw new Error("Engine not initialized. Call init() first.");
        }
        return this.engine;
    }
}
