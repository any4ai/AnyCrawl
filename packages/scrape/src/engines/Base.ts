import { BrowserCrawlingContext, CheerioCrawlingContext, Configuration, log, PlaywrightCrawlingContext, ProxyConfiguration, PuppeteerCrawlingContext, RequestQueue } from "crawlee";
import { Dictionary } from "crawlee";
import { Utils } from "../Utils.js";
import { ConfigValidator } from "../core/ConfigValidator.js";
import { DataExtractor } from "../core/DataExtractor.js";
import { JobManager } from "../core/JobManager.js";
import { EngineConfigurator, ConfigurableEngineType } from "../core/EngineConfigurator.js";

// Re-export core types for backward compatibility
export type { MetadataEntry, BaseContent, ExtractionError } from "../core/DataExtractor.js";
export { ConfigurableEngineType as BaseEngineType } from "../core/EngineConfigurator.js";

// Type definitions
export type CrawlingContext =
    | BrowserCrawlingContext<Dictionary>
    | CheerioCrawlingContext<Dictionary>
    | PlaywrightCrawlingContext<Dictionary>
    | PuppeteerCrawlingContext<Dictionary>;

export interface EngineOptions {
    minConcurrency?: number;
    maxConcurrency?: number;
    maxRequestRetries?: number;
    requestHandlerTimeoutSecs?: number;
    requestHandler?: (context: CrawlingContext) => Promise<any>;
    failedRequestHandler?: (context: CrawlingContext) => Promise<any>;
    maxRequestsPerCrawl?: number;
    maxRequestTimeout?: number;
    navigationTimeoutSecs?: number;
    requestQueueName?: string;
    requestQueue?: RequestQueue;
    autoscaledPoolOptions?: {
        isFinishedFunction: () => Promise<boolean>;
    };
    launchContext?: {
        launchOptions?: {
            args?: string[];
        };
    };
    preNavigationHooks?: ((context: CrawlingContext) => Promise<any>)[];
    additionalMimeTypes?: string[];
    keepAlive?: boolean;
    proxyConfiguration?: ProxyConfiguration;
    maxSessionRotations?: number;
    useSessionPool?: boolean;
    persistCookiesPerSession?: boolean;
    headless?: boolean;
}

/**
 * Lightweight BaseEngine abstract class
 * Delegates responsibilities to specialized classes
 */
export abstract class BaseEngine {
    protected options: EngineOptions = {};
    protected queue: RequestQueue | undefined = undefined;
    protected abstract engine: any;
    protected abstract isInitialized: boolean;

    // Composition over inheritance - use specialized classes
    protected dataExtractor = new DataExtractor();
    protected jobManager = new JobManager();

    constructor(options: EngineOptions = {}) {
        // Validate options using ConfigValidator
        ConfigValidator.validate(options);

        // Initialize storage
        Utils.getInstance().setStorageDirectory();

        // Set default options
        this.options = {
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 30,
            ...options,
        };

        // Set the request queue if provided
        this.queue = options.requestQueue;
    }

    /**
     * Create common request and failed request handlers
     */
    protected createCommonHandlers(
        customRequestHandler?: (context: any) => Promise<any>,
        customFailedRequestHandler?: (context: any) => Promise<any> | void
    ) {
        const requestHandler = async (context: any) => {
            try {
                // Run custom handler if provided
                if (customRequestHandler) {
                    await customRequestHandler(context);
                    return;
                }

                // Extract data using DataExtractor
                const data = await this.dataExtractor.extractData(context);

                // Log success
                const { queueName, jobId } = context.request.userData;
                log.info(`[${queueName}] [${jobId}] Pushing data for ${data.url}`);

                // Update job status if jobId exists
                if (jobId) {
                    await this.jobManager.markCompleted(jobId, queueName, data);
                }
            } catch (error) {
                if (context.request.userData.jobId) {
                    await this.jobManager.markFailed(context.request.userData.jobId, context.request.userData.queueName, (error as Error).message);
                }
                this.dataExtractor.handleExtractionError(context, error as Error);
            }
        };

        const failedRequestHandler = async (context: any, error: Error) => {
            // Run custom handler if provided
            if (customFailedRequestHandler) {
                const result = customFailedRequestHandler(context);
                if (result instanceof Promise) {
                    await result;
                }
                return;
            }

            // Log failure
            const { queueName, jobId } = context.request.userData;
            log.error(`[${queueName}] [${jobId}] Request ${context.request.url} failed`);

            // Update job status if jobId exists
            if (jobId) {
                await this.jobManager.markFailed(jobId, queueName, error.message);
            }
        };

        return { requestHandler, failedRequestHandler };
    }

    /**
     * Apply engine-specific configurations using EngineConfigurator
     */
    protected applyEngineConfigurations(crawlerOptions: any, engineType: ConfigurableEngineType): any {
        return EngineConfigurator.configure(crawlerOptions, engineType);
    }

    /**
     * Run the crawler
     */
    async run(): Promise<void> {
        if (!this.isInitialized) {
            await this.init();
        }

        if (!this.engine) {
            throw new Error("Engine not initialized");
        }

        const queueName = this.options.requestQueueName || 'default';

        try {
            log.info(`[${queueName}] Starting crawler engine`);
            await this.engine.run();
            log.info(`[${queueName}] Crawler engine started successfully`);
        } catch (error) {
            log.error(`[${queueName}] Error running crawler: ${error}`);
            throw error;
        }
    }

    /**
     * Stop the crawler
     */
    async stop(): Promise<void> {
        if (this.engine) {
            await this.engine.stop();
        }
    }

    /**
     * Check if the engine is initialized
     */
    isEngineInitialized(): boolean {
        return this.isInitialized;
    }

    /**
     * Abstract method for engine initialization
     */
    abstract init(): Promise<void>;
} 