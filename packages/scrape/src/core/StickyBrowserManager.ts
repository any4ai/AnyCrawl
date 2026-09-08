import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { log } from "@anycrawl/libs";
import {
    proxyConfigurationId, STICKY_SESSION_TOKEN, stickyProxySelection,
    StickyProxyConfigurationError, validateStickyProxyTemplate,
} from "./StickyProxyContext.js";

type State = "PREPARING" | "READY" | "DRAINING" | "FAILED" | "CLOSED";
interface Lease {
    provisional: Set<{ close(): Promise<void> }>;
    template: string;
    url: string;
    id: string;
    state: State;
    safeUntil: number;
    controller?: any;
    opening: number;
    pages: Set<any>;
    timer?: ReturnType<typeof setTimeout>;
    closing?: Promise<void>;
}
interface Attempt {
    context: any;
    deadline: number;
    cancelled: boolean;
    lease?: Lease;
}

export class StickyBrowserTimeoutError extends Error {
    constructor() { super("Sticky browser operation timed out before its safe deadline"); this.name = "TimeoutError"; }
}

/** One manager per crawler; only page acquisition is serialized, never navigation. */
export class StickyBrowserManager {
    private readonly leases = new Map<string, Lease>();
    private readonly attempts = new Map<string, Attempt>();
    private readonly current = new AsyncLocalStorage<Attempt>();
    private acquisition: Promise<unknown> = Promise.resolve();
    private pool: any;
    private destroyed = false;
    private readonly cleanupErrors: Error[] = [];
    private readonly provisionalClosures = new Set<Promise<void>>();
    private readonly windowMs: number;

    constructor(readonly ttlSecs: number, private readonly now = () => performance.now()) {
        this.windowMs = ttlSecs * 1000 - 10_000;
        if (!Number.isSafeInteger(ttlSecs) || this.windowMs <= 0) throw new StickyProxyConfigurationError("Invalid sticky TTL");
    }

    configure(options: any): any {
        const pool = options.browserPoolOptions ?? {};
        return {
            ...options,
            browserPoolOptions: {
                ...pool,
                preLaunchHooks: [...(pool.preLaunchHooks ?? []), (id: string, ctx: any) => {
                    const attempt = this.attempts.get(id);
                    const lease = attempt?.lease;
                    const explicitProxy = ctx.launchOptions?.proxy;
                    const inlineProxy = [...(ctx.launchOptions?.args ?? []), ...(ctx.launchOptions?.launchOptions?.args ?? [])]
                        .some((arg: string) => arg.startsWith("--proxy-server="));
                    if (!lease || ctx.proxyUrl !== lease.url) {
                        if (ctx.proxyUrl || explicitProxy || inlineProxy) throw new StickyProxyConfigurationError("Unmanaged proxy browser launch");
                        return;
                    }
                    if ((explicitProxy && explicitProxy !== lease.url) || inlineProxy) {
                        throw new StickyProxyConfigurationError("Launch options conflict with the selected sticky proxy");
                    }
                    this.check(attempt!, lease);
                    ctx.launchOptions.__anycrawlTrackBrowser = async (resource?: { close(): Promise<void> }) => {
                        if (resource) lease.provisional.add(resource);
                        if (attempt!.cancelled || this.destroyed || lease.state !== "PREPARING" || this.now() >= attempt!.deadline) {
                            await this.closeProvisional(lease);
                            throw new StickyBrowserTimeoutError();
                        }
                    };
                    const remaining = Math.max(1, Math.min(lease.safeUntil, attempt!.deadline) - this.now());
                    ctx.launchOptions.timeout = Math.min(Number(ctx.launchOptions.timeout) || 30_000, remaining);
                }],
                postLaunchHooks: [...(pool.postLaunchHooks ?? []), async (id: string, controller: any) => {
                    const lease = this.leases.get(controller.launchContext.proxyUrl);
                    if (!lease) return;
                    if (lease.controller && lease.controller !== controller) {
                        throw new StickyProxyConfigurationError("A sticky session cannot launch a second business browser");
                    }
                    lease.controller = controller;
                    lease.provisional.clear(); // Controller now owns the business browser.
                    const attempt = this.attempts.get(id);
                    if (!attempt || attempt.cancelled || this.now() >= lease.safeUntil || lease.state !== "PREPARING") {
                        this.invalidate(lease, true);
                        await this.close(lease);
                        throw new StickyBrowserTimeoutError();
                    }
                    lease.state = "READY";
                    controller.proxyTier = undefined;
                    controller.proxyUrl = lease.url;
                    controller.on("browserClosed", () => this.closed(lease));
                    // Crawlee binds browser.on, but not Puppeteer's once/off.
                    // Calling once on its Proxy breaks Puppeteer's private fields.
                    controller.browser?.on("disconnected", () => this.invalidate(lease, true));
                }],
                prePageCreateHooks: [...(pool.prePageCreateHooks ?? []), (id: string, controller: any) => {
                    const lease = this.leases.get(controller.launchContext.proxyUrl);
                    if (lease) this.check(this.attempts.get(id), lease);
                }],
                postPageCreateHooks: [...(pool.postPageCreateHooks ?? []), async (page: any, controller: any) => {
                    const lease = this.leases.get(controller.launchContext.proxyUrl);
                    if (!lease) return;
                    // A deadline can close a page before Crawlee's own cleanup.
                    // Run its pre/post-close hooks only once in that race.
                    const closePage = page.close.bind(page);
                    let pageClosing: Promise<void> | undefined;
                    page.close = (...args: any[]) => pageClosing ??= closePage(...args);
                    lease.pages.add(page);
                    page.once("close", () => {
                        lease.pages.delete(page);
                        this.closeIfDrained(lease);
                    });
                    const attempt = this.attempts.get(this.pool.getPageId(page));
                    if (!attempt || attempt.cancelled || lease.state === "FAILED" || this.now() >= lease.safeUntil) {
                        await page.close();
                        throw new StickyBrowserTimeoutError();
                    }
                }],
            },
            preNavigationHooks: [async (context: any) => {
                const attempt = this.current.getStore();
                if (attempt?.lease) this.check(attempt, attempt.lease, true);
            }, ...(options.preNavigationHooks ?? [])],
        };
    }

    attach(pool: any): void {
        this.pool = pool;
        const newPage = pool.newPage.bind(pool);
        pool.newPage = (options: any = {}) => {
            const attempt = this.current.getStore();
            if (!attempt || !options.proxyUrl) return newPage(options);
            // Choose/replace the lease after waiting for previous page acquisitions.
            // This prevents queue time and concurrent capacity claims using stale leases.
            const pending = this.acquisition.then(() => this.openPage(attempt, options, newPage));
            this.acquisition = pending.catch(() => undefined);
            return pending;
        };
        pool.on("browserRetired", (controller: any) => {
            const lease = this.leases.get(controller.launchContext.proxyUrl);
            if (lease && lease.state !== "CLOSED" && lease.state !== "FAILED") {
                lease.state = "DRAINING";
                this.closeIfDrained(lease);
            }
        });
    }

    async run(context: any, budgetMs: number, operation: () => Promise<void>): Promise<void> {
        const attempt: Attempt = { context, deadline: this.now() + budgetMs, cancelled: false };
        this.attempts.set(context.id, attempt);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await this.current.run(attempt, () => stickyProxySelection.run(true, async () => {
                await Promise.race([
                    operation(),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => {
                            attempt.cancelled = true;
                            context.request.noRetry = true;
                            if (attempt.lease) this.invalidate(attempt.lease, false);
                            reject(new StickyBrowserTimeoutError());
                        }, budgetMs);
                    }),
                ]);
            }));
        } catch (error) {
            // Invalidate before Crawlee calls its retry/error handlers. This is
            // deliberately independent of the later browserClosed event.
            if (attempt.lease) this.invalidate(attempt.lease, false);
            if (error instanceof StickyBrowserTimeoutError || error instanceof StickyProxyConfigurationError) {
                context.request.noRetry = true;
            }
            throw error;
        } finally {
            clearTimeout(timer);
            const interrupted = attempt.cancelled;
            attempt.cancelled = true;
            this.attempts.delete(context.id);
            // Normal success/error cleanup belongs to Crawlee, including allowing
            // failedRequestHandler to inspect the page. Close early only on cancel.
            if (interrupted && context.page && !context.page.isClosed()) await context.page.close().catch(() => undefined);
            if (attempt.lease) this.closeIfDrained(attempt.lease);
        }
    }

    private async openPage(attempt: Attempt, options: any, newPage: (o: any) => Promise<any>): Promise<any> {
        const template = options.proxyUrl;
        validateStickyProxyTemplate(template, this.ttlSecs);
        if (this.destroyed || attempt.cancelled || this.now() >= attempt.deadline) throw new StickyBrowserTimeoutError();
        const remaining = attempt.deadline - this.now();
        if (remaining > this.windowMs) {
            throw new StickyProxyConfigurationError(`Sticky window (${this.ttlSecs}s) cannot cover the remaining browser request budget (${Math.ceil(remaining / 1000)}s) and 10s guard`);
        }
        let lease: Lease | undefined;
        for (const candidate of this.leases.values()) {
            if (candidate.template !== template || candidate.state !== "READY") continue;
            if (!this.pool.activeBrowserControllers.has(candidate.controller)) {
                this.invalidate(candidate, false);
                continue;
            }
            if (attempt.deadline > candidate.safeUntil) {
                this.invalidate(candidate, false);
                continue;
            }
            if (candidate.pages.size + candidate.opening < this.pool.maxOpenPagesPerBrowser) { lease = candidate; break; }
        }
        if (!lease) {
            const sessionId = randomBytes(8).toString("hex");
            const url = template.replace(STICKY_SESSION_TOKEN, sessionId);
            lease = {
                template, url, id: `${proxyConfigurationId(template)}:${sessionId}`,
                state: "PREPARING", safeUntil: this.now() + this.windowMs, opening: 0, pages: new Set(), provisional: new Set(),
            };
            this.leases.set(url, lease);
            const owned = lease;
            lease.timer = setTimeout(() => this.invalidate(owned, true), this.windowMs);
            lease.timer.unref();
            log.debug(`[Sticky] allocated ${lease.id}`);
        }
        attempt.lease = lease;
        lease.opening++;
        const parsed = new URL(lease.url);
        attempt.context.proxyInfo = {
            ...attempt.context.proxyInfo,
            url: lease.url, username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
            stickyProxyTemplate: template,
        };
        try {
            this.check(attempt, lease);
            const page = await newPage({ ...options, proxyUrl: lease.url, proxyTier: undefined });
            if (attempt.cancelled || this.now() >= lease.safeUntil) {
                await page.close();
                throw new StickyBrowserTimeoutError();
            }
            return page;
        } catch (error) {
            this.invalidate(lease, true);
            throw error;
        } finally {
            lease.opening--;
            this.closeIfDrained(lease);
        }
    }

    private check(attempt: Attempt | undefined, lease: Lease, inFlight = false): void {
        const permitted = lease.state === "READY" || lease.state === "PREPARING" || (inFlight && lease.state === "DRAINING");
        if (!attempt || attempt.cancelled || !permitted || this.now() >= attempt.deadline || attempt.deadline > lease.safeUntil) {
            throw new StickyBrowserTimeoutError();
        }
    }

    private invalidate(lease: Lease, failed: boolean): void {
        if (lease.state === "CLOSED") return;
        lease.state = failed || lease.state === "FAILED" ? "FAILED" : "DRAINING";
        if (lease.controller) this.pool.retireBrowserController(lease.controller);
        if (failed || !lease.controller) void this.close(lease);
        else this.closeIfDrained(lease);
    }

    private closeIfDrained(lease: Lease): void {
        if (["DRAINING", "FAILED"].includes(lease.state) && lease.pages.size === 0 && lease.opening === 0) {
            if (lease.controller) void this.close(lease);
            else this.closed(lease);
        }
    }

    private async close(lease: Lease): Promise<void> {
        if (lease.closing) return lease.closing;
        if (!lease.controller) { await this.closeProvisional(lease); return; }
        lease.closing = (async () => {
            try { await lease.controller.close(); this.closed(lease); }
            catch (error) {
                const failure = new Error(`Sticky cleanup failed for ${lease.id}`);
                this.cleanupErrors.push(failure);
                log.error(failure.message);
            }
        })();
        return lease.closing;
    }

    private closed(lease: Lease): void {
        lease.state = "CLOSED";
        clearTimeout(lease.timer);
        this.leases.delete(lease.url);
        if (lease.controller) {
            this.pool.activeBrowserControllers.delete(lease.controller);
            this.pool.startingBrowserControllers?.delete(lease.controller);
            this.pool.retiredBrowserControllers?.delete(lease.controller);
        }
    }

    private async closeProvisional(lease: Lease): Promise<void> {
        const resources = [...lease.provisional];
        lease.provisional.clear();
        if (!resources.length) return;
        const closing = Promise.all(resources.map(async resource => {
            try { await resource.close(); }
            catch { this.cleanupErrors.push(new Error(`Sticky provisional browser cleanup failed for ${lease.id}`)); }
        })).then(() => undefined);
        this.provisionalClosures.add(closing);
        try { await closing; } finally { this.provisionalClosures.delete(closing); }
    }

    async destroy(): Promise<void> {
        this.destroyed = true;
        for (const attempt of this.attempts.values()) attempt.cancelled = true;
        await Promise.all([...this.leases.values()].map(async (lease) => {
            clearTimeout(lease.timer);
            this.invalidate(lease, true);
            await this.close(lease);
        }));
        // A cancelled SDK launch can finish after the request has been reclaimed.
        // Its tracking callback still closes it before this acquisition settles.
        await this.acquisition;
        await Promise.all([...this.provisionalClosures]);
        if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, "Sticky browser cleanup failed");
    }
}
