import {
    PlaywrightCrawler, PuppeteerCrawler,
    type PlaywrightCrawlingContext, type PuppeteerCrawlingContext,
} from "crawlee";
import { config, getBaseProxyUrls, getStealthProxyUrls } from "@anycrawl/libs";
import { StickyBrowserManager } from "../core/StickyBrowserManager.js";
import { validateStickyProxyTemplate } from "../core/StickyProxyContext.js";

function createManager(options: any): StickyBrowserManager {
    const ttl = config.proxy.stickyTtlSecs!;
    const proxies = [
        ...getBaseProxyUrls(), ...getStealthProxyUrls(),
        ...(options.proxyConfiguration?.proxyUrls ?? []),
        ...(options.proxyConfiguration?.tieredProxyUrls ?? []).flat(),
    ].filter((url): url is string => typeof url === "string");
    for (const url of proxies) validateStickyProxyTemplate(url, ttl);
    return new StickyBrowserManager(ttl);
}

export class StickyPlaywrightCrawler extends PlaywrightCrawler {
    readonly stickyManager: StickyBrowserManager;
    constructor(options: any) {
        const manager = createManager(options);
        super(manager.configure(options));
        this.stickyManager = manager;
        manager.attach(this.browserPool);
    }
    protected override async _runRequestHandler(context: PlaywrightCrawlingContext): Promise<void> {
        // Crawlee's outer budget includes navigation, handler and its timeout
        // buffer. Use that enforced bound, not the navigation-only timeout.
        await this.stickyManager.run(context, this.requestHandlerTimeoutMillis, () => super._runRequestHandler(context));
    }
    override async teardown(): Promise<void> {
        try { await this.stickyManager.destroy(); }
        finally { await super.teardown(); }
    }
}

export class StickyPuppeteerCrawler extends PuppeteerCrawler {
    readonly stickyManager: StickyBrowserManager;
    constructor(options: any) {
        const manager = createManager(options);
        super(manager.configure(options));
        this.stickyManager = manager;
        manager.attach(this.browserPool);
    }
    protected override async _runRequestHandler(context: PuppeteerCrawlingContext): Promise<void> {
        await this.stickyManager.run(context, this.requestHandlerTimeoutMillis, () => super._runRequestHandler(context));
    }
    override async teardown(): Promise<void> {
        try { await this.stickyManager.destroy(); }
        finally { await super.teardown(); }
    }
}
