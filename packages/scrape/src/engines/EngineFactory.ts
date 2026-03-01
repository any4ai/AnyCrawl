import { RequestQueueV2, LaunchContext } from "crawlee";
import type { EngineOptions } from "../types/engine.js";

// Use type-only reference to avoid runtime import of Base and engines
export type Engine = import("./Base.js").BaseEngine;

// Base factory interface
export interface IEngineFactory {
    createEngine(queue: RequestQueueV2, options?: EngineOptions): Promise<Engine>;
}

// Default configurations
const defaultOptions: EngineOptions = {
    requestHandlerTimeoutSecs: process.env.ANYCRAWL_REQUEST_HANDLER_TIMEOUT_SECS ? parseInt(process.env.ANYCRAWL_REQUEST_HANDLER_TIMEOUT_SECS) : 600,
    keepAlive: process.env.ANYCRAWL_KEEP_ALIVE === "false" ? false : true,
    useSessionPool: true,
    persistCookiesPerSession: false
};

if (process.env.ANYCRAWL_MIN_CONCURRENCY) {
    defaultOptions.minConcurrency = parseInt(process.env.ANYCRAWL_MIN_CONCURRENCY);
}
if (process.env.ANYCRAWL_MAX_CONCURRENCY) {
    defaultOptions.maxConcurrency = parseInt(process.env.ANYCRAWL_MAX_CONCURRENCY);
}

// Build platform-aware Chromium args to avoid instability on macOS/Windows
const defaultLaunchContext: Partial<LaunchContext> = {
    launchOptions: {
        args: (() => {
            const isLinux = process.platform === 'linux';
            const baseArgs = [
                "--no-first-run",
                "--disable-accelerated-2d-canvas",
            ];
            const sslArgs = (process.env.ANYCRAWL_IGNORE_SSL_ERROR === "true")
                ? ["--ignore-certificate-errors", "--ignore-certificate-errors-spki-list"]
                : [];
            if (isLinux) {
                // Only apply these flags on Linux/Docker where they're needed
                return [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--no-zygote",
                    "--disable-gpu",
                    ...baseArgs,
                    ...sslArgs,
                ];
            }
            // On macOS/Windows, avoid single-process/no-sandbox which cause random page crashes
            return [
                ...baseArgs,
                ...sslArgs,
            ];
        })(),
        defaultViewport: {
            width: 1920,
            height: 1080
        },
        ignoreHTTPSErrors: process.env.ANYCRAWL_IGNORE_SSL_ERROR === "true" ? true : false,
    },
    // Add user agent if set
    ...(process.env.ANYCRAWL_USER_AGENT ? {
        userAgent: process.env.ANYCRAWL_USER_AGENT
    } : {}),
};

const defaultHttpOptions: Record<string, any> = {
    ignoreSslErrors: process.env.ANYCRAWL_IGNORE_SSL_ERROR === "true" ? true : false,
};

function mergeLaunchContexts(
    baseLaunchContext: EngineOptions["launchContext"] | undefined,
    overrideLaunchContext: EngineOptions["launchContext"] | undefined
): EngineOptions["launchContext"] | undefined {
    if (!baseLaunchContext && !overrideLaunchContext) return undefined;

    const baseArgs = baseLaunchContext?.launchOptions?.args || [];
    const overrideArgs = overrideLaunchContext?.launchOptions?.args || [];
    const mergedArgs = [...new Set([...baseArgs, ...overrideArgs])];

    return {
        ...baseLaunchContext,
        ...overrideLaunchContext,
        launchOptions: {
            ...(baseLaunchContext?.launchOptions || {}),
            ...(overrideLaunchContext?.launchOptions || {}),
            ...(mergedArgs.length > 0 ? { args: mergedArgs } : {}),
        },
    };
}

// Shared proxy configuration loader to avoid code duplication
let cachedProxyConfiguration: any = null;
async function getProxyConfiguration() {
    if (!cachedProxyConfiguration) {
        const proxyMod = await import("../managers/Proxy.js");
        cachedProxyConfiguration = proxyMod.default;
    }
    return cachedProxyConfiguration;
}

// Base factory class to reduce code duplication
abstract class BaseEngineFactory implements IEngineFactory {
    protected abstract engineModule: string;
    protected abstract engineClass: string;

    async createEngine(queue: RequestQueueV2, options?: EngineOptions): Promise<Engine> {
        const mod = await import(this.engineModule);
        const EngineClass = mod[this.engineClass];
        const proxyConfiguration = await getProxyConfiguration();
        const engineSpecificOptions = this.getEngineSpecificOptions();
        const mergedLaunchContext = mergeLaunchContexts(
            engineSpecificOptions.launchContext as EngineOptions["launchContext"] | undefined,
            options?.launchContext
        );

        return new EngineClass({
            ...defaultOptions,
            proxyConfiguration,
            requestQueue: queue,
            ...engineSpecificOptions,
            ...options,
            ...(mergedLaunchContext ? { launchContext: mergedLaunchContext } : {}),
        });
    }

    protected abstract getEngineSpecificOptions(): Record<string, any>;
}

// Concrete factory implementations
export class CheerioEngineFactory extends BaseEngineFactory {
    protected engineModule = "./Cheerio.js";
    protected engineClass = "CheerioEngine";

    protected getEngineSpecificOptions(): Record<string, any> {
        return {
            additionalMimeTypes: ["text/html", "text/plain", "application/xhtml+xml"],
            ...defaultHttpOptions,
        };
    }
}

export class PlaywrightEngineFactory extends BaseEngineFactory {
    protected engineModule = "./Playwright.js";
    protected engineClass = "PlaywrightEngine";

    protected getEngineSpecificOptions(): Record<string, any> {
        return {
            launchContext: defaultLaunchContext,
        };
    }
}

export class PuppeteerEngineFactory extends BaseEngineFactory {
    protected engineModule = "./Puppeteer.js";
    protected engineClass = "PuppeteerEngine";

    protected getEngineSpecificOptions(): Record<string, any> {
        return {
            launchContext: defaultLaunchContext,
        };
    }
}

// Factory registry and main factory
export class EngineFactoryRegistry {
    private static factories = new Map<string, IEngineFactory>();

    static {
        // Register default factories
        this.register('cheerio', new CheerioEngineFactory());
        this.register('playwright', new PlaywrightEngineFactory());
        this.register('puppeteer', new PuppeteerEngineFactory());
    }

    static register(engineType: string, factory: IEngineFactory): void {
        this.factories.set(engineType, factory);
    }

    static async createEngine(
        engineType: string,
        queue: RequestQueueV2,
        options?: EngineOptions
    ): Promise<Engine> {
        const factory = this.factories.get(engineType);
        if (!factory) {
            throw new Error(`No factory registered for engine type: ${engineType}`);
        }
        return factory.createEngine(queue, options);
    }

    static getRegisteredEngineTypes(): string[] {
        return Array.from(this.factories.keys());
    }
}
