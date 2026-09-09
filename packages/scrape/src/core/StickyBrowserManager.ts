import { cloudflareBrowserContext, confirmedCloudflareOrigin, disposeCloudflareContext } from '../challenges/cloudflare/CloudflareSessionRegistry.js';
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { config, log } from "@anycrawl/libs";
import {
    proxyConfigurationId, STICKY_SESSION_TOKEN, stickyProxySelection,
    StickyProxyConfigurationError, validateStickyProxyTemplate,
} from "./StickyProxyContext.js";

import { applyBrowserRecovery, BrowserOriginUnavailableError, requestOrigin } from "./BrowserRecoveryPolicy.js";
import { stickyLeasePreference } from "./StickyProxyContext.js";

type State = "PREPARING" | "READY" | "DRAINING" | "FAILED" | "CLOSED";
interface Lease {
    provisional: Set<{ close(): Promise<void> }>;
    template: string;
    url: string;
    id: string;
    state: State;
    safeUntil: number;
    createdAt: number;
    excludedOrigins: Set<string>;
    successfulOrigins: Set<string>;
    contexts: Set<object>;
    retireReason?: string;
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
    controller: AbortController;
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
    private readonly closedLeases: Array<{id:string;createdAt:number;closedAt:number;retireReason:string}> = [];

    constructor(readonly ttlSecs: number, private readonly now = () => performance.now()) {
        this.windowMs = ttlSecs * 1000 - 10_000;
        if (!Number.isSafeInteger(ttlSecs) || this.windowMs <= 0) throw new StickyProxyConfigurationError("Invalid sticky TTL");
    }

    configure(options: any): any {
        const pool = options.browserPoolOptions ?? {};
        return {
            ...options,
            // Crawlee's session.markBad()/blocked-status handling retires a browser
            // on any page error. Sticky leases own identity and origin health instead.
            useSessionPool: false,
            persistCookiesPerSession: false,
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
                    const browserContext = cloudflareBrowserContext(page);
                    if (browserContext) lease.contexts.add(browserContext);
                    const owner = this.attempts.get(this.pool.getPageId(page));
                    page.__anycrawlAbortSignal = owner?.controller.signal;
                    page.__anycrawlBrowserDeadlineAt = owner?.context.request.userData?._anycrawlBrowserDeadlineAt;
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
                if (attempt?.lease) {
                    this.check(attempt, attempt.lease, true);
                    this.checkOrigin(attempt.lease, context.request.url);
                }
            }, ...(options.preNavigationHooks ?? [])],
            postNavigationHooks: [async (context: any) => {
                const attempt = this.current.getStore();
                if (attempt?.lease) this.checkOrigin(attempt.lease, context.page?.url?.() ?? context.request.loadedUrl);
            }, ...(options.postNavigationHooks ?? [])],
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
                lease.retireReason ??= "pool_retirement";
                lease.state = "DRAINING";
                this.closeIfDrained(lease);
            }
        });
    }

    async run(context: any, budgetMs: number, operation: () => Promise<void>): Promise<void> {
        delete context.__anycrawlLeaseFailure;
        delete context.__anycrawlRecoveryError;
        delete context.__anycrawlRecoveryDecision;
        const data = context.request.userData ??= {};
        data._anycrawlBrowserStartedAt ??= Date.now();
        data._anycrawlBrowserDeadlineAt ??= Date.now() + budgetMs;
        const remaining = Math.min(budgetMs, data._anycrawlBrowserDeadlineAt - Date.now());
        if (remaining <= 0) { context.request.noRetry = true; throw new StickyBrowserTimeoutError(); }
        const attempt: Attempt = { context, deadline: this.now() + remaining, cancelled: false, controller: new AbortController() };
        context.__anycrawlAbortSignal = attempt.controller.signal;
        this.attempts.set(context.id, attempt);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await this.current.run(attempt, () => stickyLeasePreference.run(
                templates => this.preferTemplate(templates, attempt),
                () => stickyProxySelection.run(true, async () => {
                await Promise.race([
                    operation(),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => {
                            attempt.cancelled = true;
                            context.request.noRetry = true;
                            attempt.controller.abort(new StickyBrowserTimeoutError());
                            reject(new StickyBrowserTimeoutError());
                        }, remaining);
                    }),
                ]);
            })));
            if (attempt.lease && !config.engine.browserIsolateContexts) {
                const origin = requestOrigin(context.page?.url?.() ?? context.request.url);
                const response = context.response;
                const status = typeof response?.status === 'function' ? response.status() : response?.statusCode;
                if (origin && status >= 200 && status < 400) attempt.lease.successfulOrigins.add(origin);
            }
        } catch (error) {
            const decision = applyBrowserRecovery(context, error as Error);
            attempt.controller.abort(error);
            if (attempt.lease) {
                if (decision.leaseAction === 'retire') this.invalidate(attempt.lease, false, decision.failureKind);
                if (decision.leaseAction === 'exclude_origin') {
                    for (const url of [context.page?.url?.(), context.request.url]) {
                        const origin = requestOrigin(url);
                        if (origin) attempt.lease.excludedOrigins.add(origin);
                    }
                }
            }
            log.debug(`[Sticky recovery] kind=${decision.failureKind} scope=${decision.scope} action=${decision.proxyAction}`);
            throw error;
        } finally {
            clearTimeout(timer);
            const interrupted = attempt.cancelled;
            attempt.cancelled = true;
            this.attempts.delete(context.id);
            // Normal success/error cleanup belongs to Crawlee, including allowing
            // failedRequestHandler to inspect the page. Close early only on cancel.
            if (interrupted && context.page && !context.page.isClosed()) {
                try { await context.page.close(); }
                catch { if (attempt.lease) this.invalidate(attempt.lease, true, 'cleanup_failure'); }
            }
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
        const origin = requestOrigin(attempt.context.request.url);
        const candidates = [...this.leases.values()].sort((a, b) =>
            Number(Boolean(origin && [...b.contexts].some(context => confirmedCloudflareOrigin(context, origin))))
            - Number(Boolean(origin && [...a.contexts].some(context => confirmedCloudflareOrigin(context, origin))))
            || Number(Boolean(origin && b.successfulOrigins.has(origin))) - Number(Boolean(origin && a.successfulOrigins.has(origin))));
        for (const candidate of candidates) {
            if (candidate.template !== template || candidate.state !== "READY" || origin && candidate.excludedOrigins.has(origin)) continue;
            if (!this.pool.activeBrowserControllers.has(candidate.controller)) {
                this.invalidate(candidate, false);
                continue;
            }
            if (attempt.deadline > candidate.safeUntil) {
                this.invalidate(candidate, false, "ttl_budget");
                continue;
            }
            if (candidate.pages.size + candidate.opening < this.pool.maxOpenPagesPerBrowser) { lease = candidate; break; }
        }
        if (!lease) {
            const sessionId = randomBytes(8).toString("hex");
            const url = template.replace(STICKY_SESSION_TOKEN, sessionId);
            lease = {
                template, url, id: `${proxyConfigurationId(template)}:${sessionId}`,
                state: "PREPARING", createdAt: this.now(), excludedOrigins: new Set(), successfulOrigins: new Set(), contexts: new Set(), safeUntil: this.now() + this.windowMs, opening: 0, pages: new Set(), provisional: new Set(),
            };
            this.leases.set(url, lease);
            const owned = lease;
            lease.timer = setTimeout(() => this.invalidate(owned, true, "ttl"), this.windowMs);
            lease.timer.unref();
            log.debug(`[Sticky] allocated ${lease.id}`);
        }
        attempt.lease = lease;
        lease.opening++;
        const parsed = new URL(lease.url);
        attempt.context.proxyInfo = {
            ...attempt.context.proxyInfo,
            url: lease.url, username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
            stickyProxyTemplate: template, stickyProxyId: proxyConfigurationId(template), stickyLeaseId: lease.id,
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

    private checkOrigin(lease: Lease, url?: string): void {
        const origin = requestOrigin(url);
        if (origin && lease.excludedOrigins.has(origin)) throw new BrowserOriginUnavailableError('Origin excluded for this lease');
    }

    private preferTemplate(templates: string[], attempt: Attempt): string | undefined {
        const origin = requestOrigin(attempt.context.request.url);
        const eligible = [...this.leases.values()].filter(lease => templates.includes(lease.template)
            && lease.state === 'READY' && this.pool.activeBrowserControllers.has(lease.controller)
            && attempt.deadline <= lease.safeUntil && lease.pages.size + lease.opening < this.pool.maxOpenPagesPerBrowser
            && (!origin || !lease.excludedOrigins.has(origin)));
        return eligible.find(lease => origin && lease.successfulOrigins.has(origin))?.template ?? eligible[0]?.template;
    }

    /** Non-secret lifecycle evidence for diagnostics and configuration-driven E2E. */
    snapshot() {
        return [...this.leases.values()].map(lease => ({ id: lease.id, state: lease.state,
            createdAt: lease.createdAt, safeUntil: lease.safeUntil, retireReason: lease.retireReason,
            pages: lease.pages.size, opening: lease.opening }));
    }

    private invalidate(lease: Lease, failed: boolean, reason = "resource_retired"): void {
        if (lease.state === "CLOSED") return;
        lease.retireReason ??= reason;
        lease.state = failed || lease.state === "FAILED" ? "FAILED" : "DRAINING";
        if (failed) {
            for (const attempt of this.attempts.values()) {
                if (attempt.lease === lease) {
                    attempt.context.__anycrawlLeaseFailure = reason;
                    attempt.controller.abort(new Error(`Sticky lease ${reason}`));
                }
            }
        }
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

    lifecycleHistory() { return this.closedLeases.map(event => ({...event})); }

    private closed(lease: Lease): void {
        if (lease.state === 'CLOSED') return;
        this.closedLeases.push({id:lease.id,createdAt:lease.createdAt,closedAt:this.now(),retireReason:lease.retireReason ?? 'browser_closed'});
        if (this.closedLeases.length > 100) this.closedLeases.shift();
        log.debug(`[Sticky] closed ${lease.id} reason=${lease.retireReason ?? 'browser_closed'}`);
        for (const context of lease.contexts) disposeCloudflareContext(context);
        lease.contexts.clear();
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
