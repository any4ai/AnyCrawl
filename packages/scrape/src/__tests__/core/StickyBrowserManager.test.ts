import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { EventEmitter as PuppeteerEventEmitter } from 'puppeteer';
import { StickyBrowserManager } from '../../core/StickyBrowserManager.js';
import { validateStickyProxyTemplate, rejectUnexpandedProxy } from '../../core/StickyProxyContext.js';

const template = 'http://account-session-{sessionId}:secret@proxy.test:8080';
const alternate = 'http://other-session-{sessionId}:secret@proxy.test:8080';
let sequence = 0;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
class FakePool extends EventEmitter {
    activeBrowserControllers = new Set<any>();
    maxOpenPagesPerBrowser = 2;
    launched: any[] = [];
    failLaunch = false;
    failBeforeControllerAssignment = false;
    beforeLaunch?: () => Promise<void>;
    constructor(readonly options: any) { super(); }
    getPageId(page: any) { return page.id; }
    retireBrowserController(c: any) {
        if (!this.activeBrowserControllers.has(c)) return;
        this.emit('browserRetired', c);
        this.activeBrowserControllers.delete(c);
    }
    async newPage(o: any): Promise<any> {
        let c = [...this.activeBrowserControllers].find(c => c.launchContext.proxyUrl === o.proxyUrl && c.activePages < 2);
        if (!c) {
            const ctx = { proxyUrl: o.proxyUrl, launchOptions: {} };
            for (const hook of this.options.preLaunchHooks) await hook(o.id, ctx);
            await this.beforeLaunch?.();
            if (this.failLaunch) { this.failLaunch = false; throw new Error('net::ERR_PROXY_CONNECTION_FAILED'); }
            const emitter = new PuppeteerEventEmitter<any>();
            const browser = new Proxy(emitter, {
                get(target, property) {
                    return property === 'on' ? target.on.bind(target) : Reflect.get(target, property, target);
                },
            });
            c = Object.assign(new EventEmitter(), {
                browser, browserEmitter: emitter,
                launchContext: ctx, activePages: 0, pages: new Set<any>(), closed: false,
                close: async () => {
                    await Promise.resolve();
                    c.closed = true;
                    for (const page of [...c.pages]) await page.close();
                    this.activeBrowserControllers.delete(c);
                    emitter.emit('disconnected', undefined);
                    c.emit('browserClosed');
                },
            });
            this.launched.push(c);
            await (ctx.launchOptions as any).__anycrawlTrackBrowser?.(c);
            if (this.failBeforeControllerAssignment) {
                this.failBeforeControllerAssignment = false;
                throw new Error('Crawlee cancelled before controller assignment');
            }
            for (const hook of this.options.postLaunchHooks) await hook(o.id, c);
            this.activeBrowserControllers.add(c);
        }
        for (const hook of this.options.prePageCreateHooks) await hook(o.id, c);
        let closed = false;
        const page = Object.assign(new EventEmitter(), {
            id: o.id, controller: c, isClosed: () => closed,
            close: async () => {
                if (closed) return;
                closed = true; c.activePages--; c.pages.delete(page); page.emit('close');
            },
        });
        const closePage = page.close;
        page.close = async () => {
            await closePage();
            for (const hook of this.options.postPageCloseHooks ?? []) await hook(page.id, c);
        };
        c.activePages++; c.pages.add(page);
        for (const hook of this.options.postPageCreateHooks) await hook(page, c);
        return page;
    }
}
describe('sticky browser lifecycle', () => {
    let manager: StickyBrowserManager, pool: FakePool, hooks: any;
    beforeEach(() => {
        jest.useFakeTimers();
        manager = new StickyBrowserManager(120, () => Date.now());
        const options = manager.configure({}); hooks = options.preNavigationHooks;
        pool = new FakePool(options.browserPoolOptions); manager.attach(pool);
    });
    afterEach(async () => { await manager.destroy(); jest.useRealTimers(); });
    const context = () => ({ id: String(++sequence), request: { noRetry: false }, proxyInfo: { url: template }, page: undefined as any });
    const request = async (url = template, action: (ctx: any) => Promise<void> = async () => {}, budget = 30_000) => {
        const ctx = context();
        try {
            await manager.run(ctx, budget, async () => {
                ctx.page = await pool.newPage({ id: ctx.id, proxyUrl: url });
                for (const hook of hooks) await hook(ctx);
                await action(ctx);
            });
        } finally {
            // BrowserCrawler._cleanupContext owns normal page closure.
            if (ctx.page) await ctx.page.close();
        }
        return ctx;
    };
    it('reuses a healthy browser and preserves the stable cache identity', async () => {
        const a = await request(), b = await request();
        expect(a.page.controller).toBe(b.page.controller);
        expect(a.proxyInfo.url).not.toContain('{sessionId}');
        expect((b.proxyInfo as any).stickyProxyTemplate).toBe(template);
        expect(pool.launched).toHaveLength(1);
    });
    it('shares concurrent capacity without launching two browsers with one session', async () => {
        const gate = deferred(), ready = deferred(); let opened = 0;
        const tasks = Array.from({ length: 3 }, () => request(template, async () => {
            if (++opened === 3) ready.resolve(); await gate.promise;
        }));
        await ready.promise;
        expect(pool.launched).toHaveLength(2);
        expect(new Set(pool.launched.map(c => c.launchContext.proxyUrl)).size).toBe(2);
        expect(pool.launched.map(c => c.activePages).sort()).toEqual([1, 2]);
        gate.resolve(); await Promise.all(tasks);
    });
    it('respects the fallback-selected proxy and reuses its healthy browser', async () => {
        const a = await request(), b = await request(alternate), fallback = await request(alternate);
        expect(a.page.controller).not.toBe(b.page.controller);
        expect(fallback.page.controller).toBe(b.page.controller);
        expect(pool.launched).toHaveLength(2);
    });
    it('rotates when the remaining task budget no longer fits', async () => {
        const a = await request(); await jest.advanceTimersByTimeAsync(81_000);
        const b = await request();
        expect(b.proxyInfo.url).not.toBe(a.proxyInfo.url);
        expect(a.page.controller.closed).toBe(true);
    });
    it('closes an expired idle lease without prewarming', async () => {
        const a = await request(); await jest.advanceTimersByTimeAsync(110_000);
        expect(a.page.controller.closed).toBe(true);
        expect(pool.activeBrowserControllers.size).toBe(0);
        expect(pool.launched).toHaveLength(1);
        const b = await request(); expect(b.proxyInfo.url).not.toBe(a.proxyInfo.url);
    });
    it('rejects incompatible task budgets before launching', async () => {
        await expect(request(template, undefined, 600_000)).rejects.toThrow('cannot cover');
        expect(pool.launched).toHaveLength(0);
    });
    it('never revives a failed launch session', async () => {
        pool.failLaunch = true; const failed = context();
        await expect(manager.run(failed, 30_000, async () => {
            await pool.newPage({ id: failed.id, proxyUrl: template });
        })).rejects.toThrow('ERR_PROXY_CONNECTION_FAILED');
        const recovered = await request();
        expect(recovered.proxyInfo.url).not.toBe(failed.proxyInfo.url);
        expect(pool.launched).toHaveLength(1);
    });
    it('invalidates retirement immediately but lets an admitted page finish', async () => {
        let first: any;
        await request(template, async ctx => {
            first = ctx; pool.retireBrowserController(ctx.page.controller);
            for (const hook of hooks) await hook(ctx);
            const next = await request();
            expect(next.proxyInfo.url).not.toBe(first.proxyInfo.url);
            expect(first.page.isClosed()).toBe(false);
        });
        expect(first.page.controller.closed).toBe(true);
    });
    it('closes a late launch after its attempt times out', async () => {
        const gate = deferred(); pool.beforeLaunch = () => gate.promise;
        const task = request(template, undefined, 1000);
        const assertion = expect(task).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(1001); await assertion;
        gate.resolve(); await jest.advanceTimersByTimeAsync(1);
        expect(pool.launched).toHaveLength(1);
        expect(pool.launched[0].closed).toBe(true);
        expect(pool.activeBrowserControllers.size).toBe(0);
    });
    it('handles Puppeteer disconnection through Crawlee-style bound on without private-field errors', async () => {
        const first = await request();
        expect(() => first.page.controller.browserEmitter.emit('disconnected', undefined)).not.toThrow();
        const next = await request();
        expect(next.proxyInfo.url).not.toBe(first.proxyInfo.url);
        expect(first.page.controller.closed).toBe(true);
    });
    it('runs page-close hooks once when cancellation races with crawler cleanup', async () => {
        const closed = jest.fn(); pool.options.postPageCloseHooks = [closed];
        const gate = deferred();
        const task = request(template, async () => gate.promise, 1000);
        const assertion = expect(task).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(1001); await assertion;
        gate.resolve();
        expect(closed).toHaveBeenCalledTimes(1);
    });
    it('does not allow launch options to bypass global sticky management', () => {
        for (const launchOptions of [{proxy:'http://proxy.test:8080'},{args:['--proxy-server=http://proxy.test:8080']}]) {
            expect(() => pool.options.preLaunchHooks[0]('unmanaged',{launchOptions})).toThrow('Unmanaged proxy');
        }
    });
    it('rejects a launch proxy conflicting with the allocated session', async () => {
        pool.options.preLaunchHooks.unshift((_id: string, ctx: any) => {ctx.launchOptions.proxy='http://different.test:8080';});
        await expect(request()).rejects.toThrow('conflict with the selected sticky proxy');
        expect(pool.launched).toHaveLength(0);
    });
    it('closes a launched resource when Crawlee cancels before assigning its controller', async () => {
        pool.failBeforeControllerAssignment = true;
        await expect(request()).rejects.toThrow('before controller assignment');
        await jest.advanceTimersByTimeAsync(0);
        expect(pool.launched[0].closed).toBe(true);
        expect(pool.activeBrowserControllers.size).toBe(0);
    });
});
describe('sticky proxy configuration', () => {
    it('accepts username templates', () => expect(() => validateStickyProxyTemplate(template, 120)).not.toThrow());
    it.each([
        'http://user:secret@proxy.test:8080',
        'http://user:secret@{sessionId}.test:8080',
        'http://user-{sessionId}-{sessionId}:secret@proxy.test:8080',
    ])('rejects invalid templates without exposing credentials: %s', url => {
        expect(() => validateStickyProxyTemplate(url, 120)).toThrow();
        try { validateStickyProxyTemplate(url, 120); } catch (e) { expect(String(e)).not.toContain('secret'); }
    });
    it('rejects a global window exceeding the provider time parameter', () => {
        const url = 'http://account-time-2-session-{sessionId}:secret@eu-isp.flashproxy.io:30';
        expect(() => validateStickyProxyTemplate(url, 120)).not.toThrow();
        expect(() => validateStickyProxyTemplate(url, 1200)).toThrow('exceeds');
    });
    it('does not send unexpanded templates when management is off', () => {
        expect(() => rejectUnexpandedProxy(template)).toThrow('enable sticky');
        expect(() => rejectUnexpandedProxy('http://user:secret@proxy.test:8080')).not.toThrow();
    });
    it('rejects malformed encoding as a configuration error and requires the token in the username', () => {
        expect(() => validateStickyProxyTemplate('http://user%ZZ-{sessionId}:secret@proxy.test:8080',120)).toThrow('Sticky proxy');
        expect(() => validateStickyProxyTemplate('http://sessionprobe:{sessionId}@proxy.test:8080',120)).toThrow('username');
    });
});
