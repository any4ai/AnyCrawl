import { Deadline } from '../../utils/Deadline.js';
import { inspectCloudflarePage, type MainDocumentResponse } from './CloudflareDetection.js';

import { classifyContent, readRecoverySample, type RecoverySample, type VerifiedContentSnapshot } from './ContentIntegrity.js';
export { readRecoverySample, type RecoverySample } from './ContentIntegrity.js';

export interface FailedContentResource {
    epoch: number;
    type: string;
    status?: number;
    code: string;
}

/** Tracks only this page. Old challenge iframe traffic never holds a new content document open. */
export class CloudflarePageRecovery {
    readonly controller = new AbortController();
    epoch = 0;
    lastResponse?: any;
    lastActivity = Date.now();
    settledEpoch = -1;
    private settledNetworkRevision = -1;
    lastSample?: RecoverySample;
    snapshot?: VerifiedContentSnapshot;
    networkRevision = 0;
    failureCount = 0;
    readonly failures: FailedContentResource[] = [];
    private readonly requestEpochs = new WeakMap<object, number>();
    private readonly failedEpochs = new WeakMap<object, number>();
    get isSettled(): boolean {
        return this.settledEpoch === this.epoch && this.settledNetworkRevision === this.networkRevision;
    }
    private readonly pending = new Set<any>();
    private inFlight?: { epoch: number; promise: Promise<void> };
    private disposed = false;
    private readonly onRequest = (request: any) => {
        try {
            if (request.frame() !== this.page.mainFrame()) return;
            if (!['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(request.resourceType())) return;
            this.requestEpochs.set(request, this.epoch);
            this.pending.add(request); this.networkRevision++; this.lastActivity = Date.now();
        } catch { /* A detached frame cannot establish current-page loading. */ }
    };
    private readonly onFinished = (request: any) => {
        if (!this.pending.has(request)) return;
        this.pending.delete(request); this.networkRevision++; this.lastActivity = Date.now();
    };
    private recordFailure(request: any, status?: number): void {
        if (this.disposed || this.requestEpochs.get(request) !== this.epoch || this.failedEpochs.get(request) === this.epoch) return;
        this.failedEpochs.set(request, this.epoch);
        this.failureCount++; this.networkRevision++;
        const failure = request.failure?.();
        const code = status ? `HTTP_${status}` : /net::ERR_[A-Z_]+/.exec(failure?.errorText ?? '')?.[0] ?? 'REQUEST_FAILED';
        this.failures.push({ epoch: this.epoch, type: request.resourceType(), status, code });
        if (this.failures.length > 64) this.failures.shift();
    }
    private readonly onFailed = (request: any) => {
        this.recordFailure(request); this.onFinished(request);
    };
    private readonly onResponse = (response: any) => {
        try {
            const request = response.request();
            if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) this.lastResponse = response;
            if (response.status() >= 400) this.recordFailure(request, response.status());
            const epoch = this.epoch;
            void Promise.resolve(response.headers()).then(headers => {
                if (this.disposed || this.epoch !== epoch) return;
                if (Object.entries(headers).some(([key, value]) => key.toLowerCase() === 'content-type' && String(value).includes('text/event-stream')))
                    this.onFinished(request);
            }).catch(() => {});
        } catch { /* Ignore unrelated responses. */ }
    };
    private readonly onNavigation = (frame: any) => {
        if (frame !== this.page.mainFrame()) return;
        this.epoch++; this.networkRevision++; this.settledEpoch = -1; this.snapshot = undefined; this.pending.clear();
        this.failureCount = 0; this.failures.length = 0;
        this.lastActivity = Date.now();
    };
    private readonly onClose = () => this.dispose();

    constructor(readonly page: any) {
        page.__anycrawlAbortSignal?.addEventListener('abort', this.onClose, { once: true });
        if (page.__anycrawlAbortSignal?.aborted) this.controller.abort();
        page.on('request', this.onRequest); page.on('response', this.onResponse);
        page.on('requestfinished', this.onFinished); page.on('requestfailed', this.onFailed);
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
        if (this.isSettled) return;
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
            const detection = await deadline.run(async () => {
                const response = await this.documentResponse();
                if (response?.status === 407) throw Object.assign(new Error('Proxy authentication failed'), { statusCode: 407 });
                return inspectCloudflarePage(this.page, response);
            }, signal);
            if (detection.detected || ['blocked', 'rate_limited', 'http_error'].includes(detection.kind))
                throw new CloudflareRecoveryError('CF_CHALLENGE_REAPPEARED');
            let sample: RecoverySample | undefined;
            try { sample = await deadline.run(() => this.page.evaluate(readRecoverySample), signal); }
            catch (error) { if (signal.aborted || deadline.remainingMs <= 0) throw error; }
            this.lastSample = sample;
            const verdict = sample ? classifyContent(sample, this.failureCount) : { status: 'loading' };
            this.checkVerdict(verdict.status);
            const valid = sample && detection.ready && verdict.status === 'acceptable' && epoch === this.epoch;
            if (sample && valid && observedEpoch === epoch && previous === sample.fingerprint) stable++;
            else stable = valid ? 1 : 0;
            observedEpoch = epoch; previous = sample?.fingerprint ?? '';
            // Observe body stability while requests are in flight, rather than
            // restarting the same two-second window after the network drains.
            const networkQuiet = this.pending.size === 0 && Date.now() - this.lastActivity >= 1500;
            if (stable >= 3 && networkQuiet) {
                this.settledEpoch = epoch; this.settledNetworkRevision = this.networkRevision;
                return;
            }
            await deadline.sleep(1000, signal);
        }
        throw new CloudflareRecoveryError('CF_CONTENT_TIMEOUT');
    }

    async captureSnapshot(deadline: Deadline): Promise<VerifiedContentSnapshot> {
        const epoch = this.epoch, revision = this.networkRevision;
        const captured: RecoverySample = await deadline.run(() => this.page.evaluate(readRecoverySample, { captureHtml: true }), this.controller.signal);
        try {
            if (!this.isSettled || epoch !== this.epoch || revision !== this.networkRevision)
                throw new CloudflareRecoveryError('CF_CONTENT_CHANGED');
            const verdict = classifyContent(captured, this.failureCount);
            this.checkVerdict(verdict.status);
            if (verdict.status !== 'acceptable' || captured.fingerprint !== this.lastSample?.fingerprint)
                throw new CloudflareRecoveryError('CF_CONTENT_CHANGED');
            if (typeof captured.html !== 'string' || !captured.html) throw new CloudflareRecoveryError('CF_RECOVERY_STATE_MISSING');
            const { html, ...signals } = captured;
            const snapshot: VerifiedContentSnapshot = Object.freeze({ version: 1, epoch, networkRevision: revision, html, sample: Object.freeze(signals) });
            this.snapshot = snapshot; this.lastSample = signals;
            return snapshot;
        } catch (error) {
            this.settledEpoch = -1; this.snapshot = undefined;
            throw error;
        }
    }

    private checkVerdict(status: string): void {
        if (status === 'restricted') throw new CloudflareRecoveryError('CF_CONTENT_RESTRICTED');
        if (status === 'retryable_error') throw new CloudflareRecoveryError('CF_CONTENT_INVALID');
        if (status === 'unverified') throw new CloudflareRecoveryError('CF_CONTENT_UNVERIFIED');
    }

    dispose(): void {
        if (this.disposed) return;
        this.page.__anycrawlAbortSignal?.removeEventListener('abort', this.onClose);
        this.disposed = true; this.controller.abort(); this.pending.clear(); this.snapshot = undefined;
        this.page.off('request', this.onRequest); this.page.off('response', this.onResponse);
        this.page.off('requestfinished', this.onFinished); this.page.off('requestfailed', this.onFailed);
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
