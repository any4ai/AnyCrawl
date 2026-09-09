import { Deadline } from '../../utils/Deadline.js';
import { inspectCloudflarePage, type MainDocumentResponse } from './CloudflareDetection.js';

export interface RecoverySample {
    url: string;
    readyState: string;
    hasContent: boolean;
    loading: boolean;
    fingerprint: string;
    textLength: number;
}

/** Browser-evaluated CF recovery probe. No target host, site selector, or minimum article length. */
export function readRecoverySample(): RecoverySample {
    const root = document.querySelector('article') || document.querySelector('main,[role="main"]') || document.body;
    if (!root) return { url: location.href, readyState: document.readyState, hasContent: false, loading: false, fingerprint: '', textLength: 0 };
    const visible = (node: Element) => {
        const box = node.getBoundingClientRect(); const style = getComputedStyle(node);
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const external = (node: Element) => Boolean(node.closest('nav,aside,header,footer'));
    const loadingSelector = '[aria-busy="true"],[role="progressbar"],[class*="skeleton" i],[class*="loading" i]';
    let loading = root.matches(loadingSelector) && visible(root);
    for (const node of Array.from(root.querySelectorAll(loadingSelector))) {
        if (!external(node) && visible(node)) { loading = true; break; }
    }
    if (!loading) for (const node of Array.from(root.querySelectorAll('div,span,p'))) {
        if (node.children.length || external(node)) continue;
        if (/^(?:loading|please wait|加载中|正在加载)[\s.。…]*$/i.test(node.textContent?.trim() ?? '') && visible(node)) { loading = true; break; }
    }
    const text = ((root as HTMLElement).innerText ?? root.textContent ?? '').replace(/\s+/g, ' ').trim();
    const heading = root.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const contentText = heading ? text.replace(heading, '').trim() : text;
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return { url: location.href, readyState: document.readyState,
        hasContent: Boolean(contentText) || Boolean(root.querySelector('table,canvas,img,video,form')),
        loading, fingerprint: `${text.length}:${hash >>> 0}`, textLength: text.length };
}

/** Tracks only this page. Old challenge iframe traffic never holds a new content document open. */
export class CloudflarePageRecovery {
    readonly controller = new AbortController();
    epoch = 0;
    lastResponse?: any;
    lastActivity = Date.now();
    settledEpoch = -1;
    lastSample?: RecoverySample;
    private readonly pending = new Set<any>();
    private inFlight?: { epoch: number; promise: Promise<void> };
    private disposed = false;
    private readonly onRequest = (request: any) => {
        try {
            if (request.frame() !== this.page.mainFrame()) return;
            if (!['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(request.resourceType())) return;
            this.pending.add(request); this.lastActivity = Date.now();
        } catch { /* A detached frame cannot establish current-page loading. */ }
    };
    private readonly onFinished = (request: any) => {
        if (!this.pending.has(request)) return;
        this.pending.delete(request); this.lastActivity = Date.now();
    };
    private readonly onResponse = (response: any) => {
        try {
            const request = response.request();
            if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) this.lastResponse = response;
            void Promise.resolve(response.headers()).then(headers => {
                if (Object.entries(headers).some(([key, value]) => key.toLowerCase() === 'content-type' && String(value).includes('text/event-stream')))
                    this.onFinished(request);
            }).catch(() => {});
        } catch { /* Ignore unrelated responses. */ }
    };
    private readonly onNavigation = (frame: any) => {
        if (frame !== this.page.mainFrame()) return;
        this.epoch++; this.settledEpoch = -1; this.pending.clear();
        this.lastActivity = Date.now();
    };
    private readonly onClose = () => this.dispose();

    constructor(readonly page: any) {
        page.__anycrawlAbortSignal?.addEventListener('abort', this.onClose, { once: true });
        if (page.__anycrawlAbortSignal?.aborted) this.controller.abort();
        page.on('request', this.onRequest); page.on('response', this.onResponse);
        page.on('requestfinished', this.onFinished); page.on('requestfailed', this.onFinished);
        page.on('framenavigated', this.onNavigation); page.once('close', this.onClose);
    }

    async documentResponse(): Promise<MainDocumentResponse | undefined> {
        if (!this.lastResponse) return undefined;
        const headers = await this.lastResponse.headers();
        return { url: this.lastResponse.url(), status: this.lastResponse.status(),
            challenge: Object.entries(headers).some(([key, value]) => key.toLowerCase() === 'cf-mitigated' && value === 'challenge') };
    }

    get pendingCount(): number { return this.pending.size; }
    get blockingPendingCount(): number { return this.pending.size; }

    async settle(deadline: Deadline): Promise<void> {
        this.controller.signal.throwIfAborted();
        if (this.settledEpoch === this.epoch) return;
        deadline.check();
        // The current waiter observes navigation and resets its own samples.
        if (this.inFlight) return this.inFlight.promise;
        const epoch = this.epoch;
        const promise = Promise.resolve().then(() => this.runSettle(deadline));
        this.inFlight = { epoch, promise };
        try { await promise; } finally { if (this.inFlight?.promise === promise) this.inFlight = undefined; }
    }

    private async runSettle(deadline: Deadline): Promise<void> {
        const signal = this.controller.signal;
        let previous = ''; let observedEpoch = -1; let stable = 0;
        while (deadline.remainingMs > 0) {
            signal.throwIfAborted();
            const epoch = this.epoch;
            const detection = await deadline.run(async () => inspectCloudflarePage(this.page, await this.documentResponse()), signal);
            if (detection.detected || ['blocked', 'rate_limited', 'http_error'].includes(detection.kind))
                throw new CloudflareRecoveryError('CF_CHALLENGE_REAPPEARED');
            let sample: RecoverySample | undefined;
            try { sample = await deadline.run(() => this.page.evaluate(readRecoverySample), signal); }
            catch (error) { if (signal.aborted || deadline.remainingMs <= 0) throw error; }
            this.lastSample = sample;
            const valid = sample && detection.ready && sample.readyState === 'complete' && sample.hasContent
                && !sample.loading && epoch === this.epoch;
            if (sample && valid && observedEpoch === epoch && previous === sample.fingerprint) stable++;
            else stable = valid ? 1 : 0;
            observedEpoch = epoch; previous = sample?.fingerprint ?? '';
            // Observe body stability while requests are in flight, rather than
            // restarting the same two-second window after the network drains.
            const networkQuiet = this.pending.size === 0 && Date.now() - this.lastActivity >= 1500;
            if (stable >= 3 && networkQuiet) {
                this.settledEpoch = epoch;
                return;
            }
            await deadline.sleep(1000, signal);
        }
        throw new CloudflareRecoveryError('CF_CONTENT_TIMEOUT');
    }

    dispose(): void {
        if (this.disposed) return;
        this.page.__anycrawlAbortSignal?.removeEventListener('abort', this.onClose);
        this.disposed = true; this.controller.abort(); this.pending.clear();
        this.page.off('request', this.onRequest); this.page.off('response', this.onResponse);
        this.page.off('requestfinished', this.onFinished); this.page.off('requestfailed', this.onFinished);
        this.page.off('framenavigated', this.onNavigation); this.page.off('close', this.onClose);
    }
}

export class CloudflareRecoveryError extends Error {
    constructor(readonly code: string) { super(code); this.name = code.includes('TIMEOUT') ? 'TimeoutError' : 'CloudflareChallengeError'; }
}

const recoveries = new WeakMap<object, CloudflarePageRecovery>();
export function startCloudflareRecovery(page: any): CloudflarePageRecovery {
    recoveries.get(page)?.dispose();
    const recovery = new CloudflarePageRecovery(page); recoveries.set(page, recovery); return recovery;
}
export function getCloudflareRecovery(page: any): CloudflarePageRecovery | undefined { return recoveries.get(page); }
