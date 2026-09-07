import { RequestQueueV2, LaunchContext } from "crawlee";
import { config } from "@anycrawl/libs";
import { getBrowserLaunchOptions } from "../core/BrowserLaunchOptions.js";
import type { EngineOptions } from "../types/engine.js";
import {
    getCloakBrowserPlaywrightLauncher,
    getCloakBrowserPuppeteerLauncher,
} from "../core/CloakBrowserLauncher.js";

// Use type-only reference to avoid runtime import of Base and engines
export type Engine = import("./Base.js").BaseEngine;

// Base factory interface
export interface IEngineFactory {
    createEngine(queue: RequestQueueV2, options?: EngineOptions): Promise<Engine>;
}

// Default configurations
const defaultOptions: EngineOptions = {
    requestHandlerTimeoutSecs: config.navigation.requestHandlerTimeoutSecs,
    keepAlive: config.engine.keepAlive,
    useSessionPool: true,
};

if (config.engine.minConcurrency !== undefined) {
    defaultOptions.minConcurrency = config.engine.minConcurrency;
}
if (config.engine.maxConcurrency !== undefined) {
    defaultOptions.maxConcurrency = config.engine.maxConcurrency;
}

const getDefaultLaunchContext = (): Partial<LaunchContext> => ({
    launchOptions: getBrowserLaunchOptions(),
    useIncognitoPages: config.engine.browserIsolateContexts,
    browserPerProxy: true,
    ...(config.engine.userAgent ? {
        userAgent: config.engine.userAgent
    } : {}),
});

const defaultHttpOptions: Record<string, any> = {
    ignoreSslErrors: config.engine.ignoreSSLError,
};

export function mergeLaunchContexts(
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
        ...(baseLaunchContext?.launcher ? { launcher: baseLaunchContext.launcher } : {}),
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
        const engineSpecificOptions = await this.getEngineSpecificOptions();
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

    protected abstract getEngineSpecificOptions(): Record<string, any> | Promise<Record<string, any>>;
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

    protected async getEngineSpecificOptions(): Promise<Record<string, any>> {
        const launcher = await getCloakBrowserPlaywrightLauncher();
        return {
            launchContext: {
                ...getDefaultLaunchContext(),
                launcher,
            },
        };
    }
}

export class PuppeteerEngineFactory extends BaseEngineFactory {
    protected engineModule = "./Puppeteer.js";
    protected engineClass = "PuppeteerEngine";

    protected async getEngineSpecificOptions(): Promise<Record<string, any>> {
        const launcher = await getCloakBrowserPuppeteerLauncher();
        return {
            launchContext: {
                ...getDefaultLaunchContext(),
                launcher,
            },
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
