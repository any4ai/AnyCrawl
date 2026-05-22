/**
 * Engine types and interfaces to avoid circular dependencies
 */

import type { Dictionary } from "crawlee";
import type { BrowserCrawlingContext, CheerioCrawlingContext, PlaywrightCrawlingContext, PuppeteerCrawlingContext, RequestQueue, ProxyConfiguration } from "crawlee";

/**
 * Crawling context type union
 */
export type CrawlingContext =
    | BrowserCrawlingContext<Dictionary>
    | CheerioCrawlingContext<Dictionary>
    | PlaywrightCrawlingContext<Dictionary>
    | PuppeteerCrawlingContext<Dictionary>;

/**
 * Engine options interface
 */
export interface EngineOptions {
    minConcurrency?: number;
    maxConcurrency?: number;
    maxRequestRetries?: number;
    requestHandlerTimeoutSecs?: number;
    requestHandler?: (context: CrawlingContext) => Promise<any> | void;
    failedRequestHandler?: (context: CrawlingContext, error: Error) => Promise<any> | void;
    maxRequestsPerCrawl?: number;
    maxRequestTimeout?: number;
    navigationTimeoutSecs?: number;
    requestQueueName?: string;
    requestQueue?: RequestQueue;
    autoscaledPoolOptions?: {
        isFinishedFunction?: () => Promise<boolean>;
        desiredConcurrency?: number;
        scaleUpStepRatio?: number;
        scaleDownStepRatio?: number;
        maybeRunIntervalSecs?: number;
        autoscaleIntervalSecs?: number;
    };
    launchContext?: {
        launchOptions?: {
            args?: string[];
            defaultViewport?: {
                width: number;
                height: number;
            };
            [key: string]: any;
        };
        [key: string]: any;
    };
    preNavigationHooks?: ((context: CrawlingContext) => Promise<any>)[];
    postNavigationHooks?: ((context: CrawlingContext) => Promise<any>)[];
    additionalMimeTypes?: string[];
    keepAlive?: boolean;
    proxyConfiguration?: ProxyConfiguration;
    maxSessionRotations?: number;
    useSessionPool?: boolean;
    persistCookiesPerSession?: boolean;
    headless?: boolean;
    browserPoolOptions?: Record<string, any>;
    sessionPoolOptions?: Record<string, any>;
}
