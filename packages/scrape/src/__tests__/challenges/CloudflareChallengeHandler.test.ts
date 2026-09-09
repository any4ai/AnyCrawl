import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { CloudflareChallengeHandler, ensureCloudflarePageRecovered, throwIfCloudflarePreNavigationFailed } from '../../challenges/cloudflare/CloudflareChallengeHandler.js';
import { CloudflareNativeInteraction } from '../../challenges/cloudflare/CloudflareNativeInteraction.js';
import { CloudflarePageRecovery, getCloudflareRecovery, startCloudflareRecovery } from '../../challenges/cloudflare/CloudflarePageRecovery.js';
import { classifyCloudflareDocument, inspectCloudflarePage, type CloudflareDocument } from '../../challenges/cloudflare/CloudflareDetection.js';
import { ensureChallengeState, consumeProxyAction } from '../../challenges/ChallengeContext.js';
import { Deadline } from '../../utils/Deadline.js';
import { cloudflareSession, verifyCloudflareOnce } from '../../challenges/cloudflare/CloudflareSessionRegistry.js';

const normal: CloudflareDocument = { url: 'https://example.test/', ready: true, hasContent: true,
    widget: false, challengeForm: false, challengeRuntime: false, challengeTitle: false, challengeText: false };
const challenge = { ...normal, challengeForm: true, challengeRuntime: true };
const environment = process.env;
class Page extends EventEmitter {
    constructor(readonly browserContext = new EventEmitter()) { super(); }
    context = () => this.browserContext;
    document = { ...normal };
    content = { url: normal.url, readyState: 'complete', hasContent: true, loading: false, fingerprint: 'body', textLength: 200, html: '<html><body><article>Body</article></body></html>' };
    closed = false;
    evaluate = jest.fn(async (fn: any, _options?: any) => fn.name === 'readRecoverySample' ? this.content : this.document);
    mainFrame = () => this;
    frames = () => [];
    isClosed = () => this.closed;
    url = () => this.document.url;
    finish() { this.closed = true; this.emit('close'); }
    response(status = 200, mitigated = false, frame: any = this) {
        this.emit('response', { request: () => ({ isNavigationRequest: () => true, frame: () => frame }),
            headers: () => mitigated ? { 'cf-mitigated': 'challenge' } : {}, status: () => status, url: () => this.document.url });
    }
}
const request = (mode = 'base') => ({ url: normal.url, userData: { options: { proxy: mode } } });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); process.env = environment; });

describe('Cloudflare classification', () => {
    test.each<[CloudflareDocument | null, number, boolean, string]>([
        [normal, 200, false, 'content'], [{ ...normal, challengeTitle: true }, 200, false, 'content'], [{ ...normal, challengeText: true }, 200, false, 'content'], [{ ...normal, challengeRuntime: true }, 200, false, 'content'], [{ ...normal, widget: true }, 200, false, 'widget'],
        [normal, 403, false, 'blocked'], [normal, 429, false, 'rate_limited'], [normal, 500, false, 'http_error'],
        [normal, 200, true, 'challenge'], [challenge, 200, false, 'challenge'],
        [null, 200, false, 'unknown'], [{ ...normal, ready: false }, 200, false, 'unknown'],
    ] as Array<[CloudflareDocument | null, number, boolean, string]>)('does not confuse content, widgets, and blocking responses', (doc, status, mitigated, kind) => {
        expect(classifyCloudflareDocument(doc, { url: normal.url, status, challenge: mitigated }).kind).toBe(kind);
    });
    test('an authoritative current challenge header does not repeatedly evaluate challenge DOM', async () => {
        const page = new Page();
        expect(await inspectCloudflarePage(page, { url: normal.url, status: 403, challenge: true })).toMatchObject({ detected: true });
        expect(page.evaluate).not.toHaveBeenCalled();
    });
    test('retains a main response through CF history token rewrites and ignores different documents', () => {
        const doc = { ...normal, url: `${normal.url}?__cf_chl_rt_tk=fixture` };
        expect(classifyCloudflareDocument(doc, { url: normal.url, status: 403, challenge: true }).detected).toBe(true);
        expect(classifyCloudflareDocument(normal, { url: 'https://different.test/', status: 403, challenge: true }).detected).toBe(false);
    });
});

describe('CF native and post-challenge lifecycle', () => {
    test('a business widget neither clicks nor solves and adds no wait/listeners', async () => {
        const page = new Page(); page.document.widget = true;
        const solve = jest.fn(); Object.assign(page, { __cloudflareSolver: { solveDirect: solve } });
        const click = jest.spyOn(CloudflareNativeInteraction.prototype, 'tryClick');
        const req = request(); await new CloudflareChallengeHandler().onPostNavigation({ page, request: req });
        expect(click).not.toHaveBeenCalled(); expect(solve).not.toHaveBeenCalled();
        expect(consumeProxyAction(req)).toBe(''); expect(page.eventNames()).toEqual([]);
    });
    test('native click wins without a provider task and waits beyond a stable title/placeholder', async () => {
        jest.useFakeTimers(); const start = Date.now();
        const page = new Page(); page.document = challenge; page.content.loading = true;
        const solve = jest.fn(); Object.assign(page, { __cloudflareSolver: { solveDirect: solve } });
        jest.spyOn(CloudflareNativeInteraction.prototype, 'tryClick').mockImplementation(async () => {
            page.document = normal; page.response(200);
            return { source: 'frame-cdp', frameUrl: 'https://challenges.cloudflare.com/widget' };
        });
        setTimeout(() => { page.content.loading = false; page.content.fingerprint = 'real body'; }, 26000);
        const req = request(); let finished = false;
        const promise = new CloudflareChallengeHandler().onPostNavigation({ page, request: req }).then(() => { finished = true; });
        await jest.advanceTimersByTimeAsync(25000);
        expect(finished).toBe(false); expect(req.userData).not.toHaveProperty('_anycrawlPostChallengeSettled');
        await jest.advanceTimersByTimeAsync(5000); await promise;
        expect(Date.now() - start).toBe(30000); expect(solve).not.toHaveBeenCalled();
        expect(ensureChallengeState(req)).toMatchObject({ cleared: true, contentReady: true, nativeClickCount: 1, phase: 'ready' });
        expect(consumeProxyAction(req)).toBe(''); page.finish(); expect(page.eventNames()).toEqual([]);
    });
    test('changing the main document invalidates settled state and reuses one waiter per document', async () => {
        jest.useFakeTimers(); const page = new Page(); const req = request();
        const recovery = startCloudflareRecovery(page); page.response();
        Object.assign(ensureChallengeState(req), { detected: true, cleared: true, deadlineAt: Date.now() + 30000 });
        const first = ensureCloudflarePageRecovered(page, req); await jest.advanceTimersByTimeAsync(2500); await first;
        page.emit('framenavigated', page); page.content.loading = true; page.response();
        const next = ensureCloudflarePageRecovered(page, req); const same = ensureCloudflarePageRecovered(page, req);
        await jest.advanceTimersByTimeAsync(2000); expect(ensureChallengeState(req).contentReady).toBe(false);
        page.content.loading = false; page.content.fingerprint = 'second document';
        await jest.advanceTimersByTimeAsync(3500); await Promise.all([next, same]);
        expect(recovery.settledEpoch).toBe(1); page.finish();
    });
    test('a new caller during navigation does not create a second content observer', async () => {
        jest.useFakeTimers(); const page = new Page(); page.content.loading = true;
        const recovery = startCloudflareRecovery(page); page.response();
        const first = recovery.settle(new Deadline(Date.now() + 10000));
        await jest.advanceTimersByTimeAsync(500); page.emit('framenavigated', page); page.response();
        const second = recovery.settle(new Deadline(Date.now() + 20000));
        await jest.advanceTimersByTimeAsync(1000); page.content.loading = false;
        await jest.advanceTimersByTimeAsync(3000); await Promise.all([first, second]);
        const probes = page.evaluate.mock.calls.filter(([fn, options]) => fn.name === 'readRecoverySample' && !options?.captureHtml);
        expect(page.evaluate.mock.calls.filter(([, options]) => options?.captureHtml)).toHaveLength(0);
        expect(probes.length).toBeLessThanOrEqual(5); expect(recovery.settledEpoch).toBe(1); page.finish();
    });
    test('completed recovery is reused after its stage budget, but a new document cannot restart it', async () => {
        jest.useFakeTimers(); const page = new Page(); const req = request();
        startCloudflareRecovery(page); page.response();
        Object.assign(ensureChallengeState(req), { detected: true, cleared: true, deadlineAt: Date.now() + 3000 });
        const pending = ensureCloudflarePageRecovered(page, req); await jest.advanceTimersByTimeAsync(2500); await pending;
        const calls = page.evaluate.mock.calls.length; await jest.advanceTimersByTimeAsync(1000);
        await ensureCloudflarePageRecovered(page, req); expect(page.evaluate.mock.calls.length).toBe(calls);
        page.emit('framenavigated', page); page.response();
        await expect(ensureCloudflarePageRecovered(page, req)).rejects.toMatchObject({ code: 'CF_CONTENT_TIMEOUT' });
        expect(ensureChallengeState(req).contentReady).toBe(false); expect(req.userData).not.toHaveProperty('_anycrawlPostChallengeSettled');
        page.finish();
    });
    test('old iframe requests do not block current content, but current main-frame data does', async () => {
        jest.useFakeTimers(); const page = new Page(); const recovery = startCloudflareRecovery(page); page.response();
        const old = { frame: () => ({}), resourceType: () => 'fetch' };
        const current = { frame: () => page, resourceType: () => 'xhr' };
        page.emit('request', old); expect(recovery.pendingCount).toBe(0);
        page.emit('request', current); const pending = recovery.settle(new Deadline(Date.now() + 20000));
        await jest.advanceTimersByTimeAsync(4000); expect(recovery.settledEpoch).toBe(-1);
        page.emit('requestfinished', current); await jest.advanceTimersByTimeAsync(3000); await pending;
        expect(recovery.settledEpoch).toBe(0); page.finish();
    });
    test('content timeout keeps clearance separate and never requests proxy rotation', async () => {
        jest.useFakeTimers(); process.env = { ...environment, ANYCRAWL_STEALTH_TIMEOUT_MS: '4000' };
        const page = new Page(); page.document = challenge; page.content.loading = true;
        jest.spyOn(CloudflareNativeInteraction.prototype, 'tryClick').mockImplementation(async () => {
            page.document = normal; page.response(); return { source: 'frame-cdp', frameUrl: 'https://challenges.cloudflare.com/widget' };
        });
        const req = request('auto'); const pending = new CloudflareChallengeHandler().onPostNavigation({ page, request: req });
        await jest.advanceTimersByTimeAsync(4100); await pending;
        expect(ensureChallengeState(req)).toMatchObject({ cleared: true, contentReady: false, lastError: { code: 'CF_CONTENT_TIMEOUT' } });
        expect(consumeProxyAction(req)).toBe(''); expect(page.eventNames()).toEqual([]);
    });
    test('closing a page cancels a hanging observation and removes its listeners', async () => {
        jest.useFakeTimers(); const page = new Page(); const recovery = new CloudflarePageRecovery(page);
        page.evaluate.mockImplementation(() => new Promise(() => {}));
        const pending = recovery.settle(new Deadline(Date.now() + 10000));
        const outcome = expect(pending).rejects.toBeDefined();
        await jest.advanceTimersByTimeAsync(1); page.finish(); await outcome;
        expect(page.eventNames()).toEqual([]);
    });
    test('native stage expiration requests the existing auto upgrade, not a global timeout', async () => {
        jest.useFakeTimers(); process.env = { ...environment, ANYCRAWL_PROXY_STEALTH_URL: 'http://proxy.fixture:8080' };
        const page = new Page(); page.document = challenge;
        jest.spyOn(CloudflareNativeInteraction.prototype, 'tryClick').mockResolvedValue(null);
        const req = request('auto'); const pending = new CloudflareChallengeHandler().onPostNavigation({ page, request: req });
        await jest.advanceTimersByTimeAsync(60100); await pending;
        expect(ensureChallengeState(req).lastError?.code).toBe('CF_NATIVE_NOT_CLEARED');
        expect(consumeProxyAction(req)).toBe('upgrade_to_stealth'); expect(page.eventNames()).toEqual([]);
    });
    test('solver remains reachable after native stage expires and clearance is rechecked', async () => {
        jest.useFakeTimers(); const page = new Page(); page.document = challenge;
        jest.spyOn(CloudflareNativeInteraction.prototype, 'tryClick').mockResolvedValue(null);
        const solve = jest.fn(async () => { page.document = normal; page.response(); return { success: true }; });
        Object.assign(page, { __cloudflareSolver: { solveDirect: solve } });
        const req = request('stealth'); const pending = new CloudflareChallengeHandler().onPostNavigation({ page, request: req });
        await jest.advanceTimersByTimeAsync(65000); await pending;
        expect(solve).toHaveBeenCalledTimes(1);
        expect(ensureChallengeState(req)).toMatchObject({ cleared: true, contentReady: true, phase: 'ready' });
        expect(consumeProxyAction(req)).toBe(''); page.finish();
    });
    test('only main-document responses establish clearance', async () => {
        const page = new Page(); const recovery = startCloudflareRecovery(page);
        page.response(403, true); page.response(200, false, {});
        expect((await recovery.documentResponse())?.challenge).toBe(true);
        page.response(200); expect((await recovery.documentResponse())?.status).toBe(200);
        page.finish(); expect(getCloudflareRecovery(page)?.controller.signal.aborted).toBe(true);
    });
});

describe('context clearance reuse across distinct documents', () => {
    test('article B uses its own deadline and waits for delayed data without another click or solver', async () => {
        jest.useFakeTimers();
        const a = new Page(); a.document = { ...challenge };
        const click = jest.spyOn(CloudflareNativeInteraction.prototype, 'tryClick').mockImplementation(async (page: any) => {
            page.document = { ...normal }; page.response(); return { source: 'frame-cdp', frameUrl: 'https://challenges.cloudflare.com/widget' };
        });
        const handler = new CloudflareChallengeHandler(), first = request();
        const cold = handler.onPostNavigation({ page: a, request: first });
        await jest.advanceTimersByTimeAsync(3000); await cold; a.finish();
        await jest.advanceTimersByTimeAsync(130000); // First request's budget expired.
        const b = new Page(a.browserContext); b.document.url = `${normal.url}article-b`;
        b.content.url = b.document.url; b.content.loading = true;
        const second = request(); second.url = b.document.url;
        const solve = jest.fn(); Object.assign(b, { __cloudflareSolver: { solveDirect: solve } });
        let done = false; const hot = handler.onPostNavigation({ page: b, request: second }).then(() => { done = true; });
        await jest.advanceTimersByTimeAsync(10000); expect(done).toBe(false);
        b.content.loading = false; b.content.fingerprint = 'article B complete body';
        await jest.advanceTimersByTimeAsync(3000); await hot;
        expect(ensureChallengeState(second)).toMatchObject({ detected: false, sessionReused: true,
            requiresContentRecovery: true, cleared: true, contentReady: true, phase: 'ready' });
        expect(ensureChallengeState(second).deadlineAt).toBeGreaterThan(ensureChallengeState(first).deadlineAt!);
        expect(click).toHaveBeenCalledTimes(1); expect(solve).not.toHaveBeenCalled(); b.finish();
    });

    test('a reused page content timeout remains an explicit failure with detected=false', async () => {
        jest.useFakeTimers(); process.env = { ...environment, ANYCRAWL_STEALTH_TIMEOUT_MS: '5000' };
        const a = new Page(); a.document = { ...challenge };
        jest.spyOn(CloudflareNativeInteraction.prototype, 'tryClick').mockImplementation(async () => {
            a.document = { ...normal }; a.response(); return { source: 'frame-cdp', frameUrl: 'https://challenges.cloudflare.com/widget' };
        });
        const handler = new CloudflareChallengeHandler();
        const cold = handler.onPostNavigation({ page: a, request: request() }); await jest.advanceTimersByTimeAsync(3000); await cold;
        const b = new Page(a.browserContext); b.content.loading = true; const req = request();
        const hot = handler.onPostNavigation({ page: b, request: req }); await jest.advanceTimersByTimeAsync(5000); await hot;
        expect(ensureChallengeState(req)).toMatchObject({ detected: false, cleared: true,
            requiresContentRecovery: true, contentReady: false, phase: 'failed', lastError: { code: 'CF_CONTENT_TIMEOUT' } });
        expect(consumeProxyAction(req)).toBe(''); expect(b.eventNames()).toEqual([]); a.finish(); b.finish();
    });

    test('followers proceed after clearance while the leader article is still loading', async () => {
        jest.useFakeTimers(); const a = new Page(), b = new Page(a.browserContext);
        a.document = { ...challenge }; b.document = { ...challenge }; a.content.loading = true;
        const click = jest.spyOn(CloudflareNativeInteraction.prototype, 'tryClick').mockImplementation(async (page: any) => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            page.document = { ...normal }; page.response();
            return { source: 'frame-cdp', frameUrl: 'https://challenges.cloudflare.com/widget' };
        });
        const reload = jest.fn(async () => { b.document = { ...normal }; b.emit('framenavigated', b); b.response(); });
        Object.assign(b, { reload });
        const handler = new CloudflareChallengeHandler(), ra = request(), rb = request();
        let aDone = false, bDone = false;
        const first = handler.onPostNavigation({ page: a, request: ra }).then(() => { aDone = true; });
        const second = handler.onPostNavigation({ page: b, request: rb }).then(() => { bDone = true; });
        await jest.advanceTimersByTimeAsync(6000);
        expect(bDone).toBe(true); expect(aDone).toBe(false);
        expect(click).toHaveBeenCalledTimes(1); expect(reload).toHaveBeenCalledTimes(1);
        expect(ensureChallengeState(ra).verificationLeader).toBe(true);
        expect(ensureChallengeState(rb).verificationLeader).toBe(false);
        a.content.loading = false; await jest.advanceTimersByTimeAsync(3000); await Promise.all([first, second]);
        a.finish(); b.finish();
    });

    test('loading at the native boundary uses remaining total budget instead of starting a solver', async () => {
        jest.useFakeTimers(); const page = new Page(); page.document = { ...challenge };
        const solve = jest.fn(); Object.assign(page, { __cloudflareSolver: { solveDirect: solve } });
        jest.spyOn(CloudflareNativeInteraction.prototype, 'tryClick').mockResolvedValue(null);
        setTimeout(() => { page.document = { ...normal, ready: false }; page.response(); }, 59500);
        setTimeout(() => { page.document.ready = true; }, 65000);
        const req = request(); const pending = new CloudflareChallengeHandler().onPostNavigation({ page, request: req });
        await jest.advanceTimersByTimeAsync(61000);
        expect(ensureChallengeState(req).cleared).not.toBe(true); expect(solve).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(8000); await pending;
        expect(ensureChallengeState(req)).toMatchObject({ cleared: true, contentReady: true });
        expect(solve).not.toHaveBeenCalled(); page.finish();
    });
});


describe('known in-flight verification before navigation', () => {
    test.each([true, false])('waits before navigation and propagates shared result (cleared=%s)', async cleared => {
        jest.useFakeTimers(); const ownerPage = new Page(), follower = new Page(ownerPage.browserContext);
        follower.document.url = 'about:blank'; const session = cloudflareSession(ownerPage)!;
        let resolve!: (result: { cleared: boolean; origin: string; code?: string }) => void;
        const operation = jest.fn(async () => new Promise<{ cleared: boolean; origin: string; code?: string }>(r => { resolve = r; }));
        const verification = verifyCloudflareOnce(session, 0, new Deadline(Date.now() + 10000), new AbortController().signal, operation);
        await jest.advanceTimersByTimeAsync(0);
        let readyToNavigate = false; const req = request();
        const pre = new CloudflareChallengeHandler().onPreNavigation({ page: follower, request: req }).then(() => { readyToNavigate = true; });
        await jest.advanceTimersByTimeAsync(1000); expect(readyToNavigate).toBe(false);
        resolve({ cleared, origin: new URL(normal.url).origin, code: cleared ? undefined : 'CF_NATIVE_NOT_CLEARED' });
        await verification.promise; await pre;
        expect(ensureChallengeState(req).verificationLeader).toBe(false);
        if (cleared) expect(() => throwIfCloudflarePreNavigationFailed(req)).not.toThrow();
        else {
            expect(() => throwIfCloudflarePreNavigationFailed(req)).toThrow('CF_NATIVE_NOT_CLEARED');
            expect((req as any).noRetry).toBe(true);
        }
        expect(operation).toHaveBeenCalledTimes(1); ownerPage.finish(); follower.finish();
    });
});

test('five simultaneous challenged requests have one owner and independent body completion', async () => {
    jest.useFakeTimers(); const context = new EventEmitter(); const pages = Array.from({ length: 5 }, () => new Page(context));
    pages.forEach(page => { page.document = { ...challenge }; page.content.loading = true; });
    const click = jest.spyOn(CloudflareNativeInteraction.prototype, 'tryClick').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        pages.forEach(page => { page.document = { ...normal }; page.response(); });
        return { source: 'frame-cdp', frameUrl: 'https://challenges.cloudflare.com/widget' };
    });
    const handler = new CloudflareChallengeHandler(), requests = pages.map(() => request());
    const finished: number[] = [];
    const pending = pages.map((page, index) => handler.onPostNavigation({ page, request: requests[index] }).then(() => {
        finished.push(index); page.finish();
    }));
    pages.forEach((page, index) => setTimeout(() => { page.content.loading = false; }, 1000 + index * 1000));
    await jest.advanceTimersByTimeAsync(4500);
    expect(finished).toContain(0); expect(finished).not.toContain(4);
    await jest.advanceTimersByTimeAsync(5000); await Promise.all(pending);
    expect(click).toHaveBeenCalledTimes(1);
    expect(requests.filter(req => ensureChallengeState(req).verificationLeader)).toHaveLength(1);
    expect(requests.every(req => ensureChallengeState(req).contentReady)).toBe(true);
    expect(new Set(requests.map(req => ensureChallengeState(req).verificationGeneration)).size).toBe(1);
});
