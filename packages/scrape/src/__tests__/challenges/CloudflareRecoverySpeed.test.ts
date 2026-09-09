import { afterEach, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { CloudflarePageRecovery } from '../../challenges/cloudflare/CloudflarePageRecovery.js';
import { Deadline } from '../../utils/Deadline.js';

class Page extends EventEmitter {
    content = { url: 'https://example.com/article', readyState: 'complete', hasContent: true,
        loading: false, fingerprint: 'full body', textLength: 400 };
    mainFrame = () => this;
    url = () => this.content.url;
    isClosed = () => false;
    evaluate = jest.fn(async (fn: any) => fn.name === 'readRecoverySample' ? { ...this.content } : {
        url: this.url(), ready: true, hasContent: true, widget: false, challengeForm: false,
        challengeRuntime: false, challengeTitle: false, challengeText: false,
    });
    request(url = 'https://external.net/data') {
        const request = { frame: () => this, resourceType: () => 'fetch', url: () => url,
            isNavigationRequest: () => false };
        this.emit('request', request);
        return request;
    }
}
afterEach(() => { jest.useRealTimers(); });

test('a persistent cross-site request times out instead of returning a partial body', async () => {
    jest.useFakeTimers(); const page = new Page(); const recovery = new CloudflarePageRecovery(page);
    page.request();
    const pending = recovery.settle(new Deadline(Date.now() + 20000));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CF_CONTENT_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(20000); await rejected;
    expect(recovery.pendingCount).toBe(1); expect(recovery.blockingPendingCount).toBe(1);
    recovery.dispose(); expect(page.eventNames()).toEqual([]); expect(jest.getTimerCount()).toBe(0);
});

test.each<[string, string]>([
    ['cross-site', 'https://external.net/body'],
    ['same-site', 'https://api.example.com/body'],
    ['unknown public suffix', 'https://external.internal/body'],
    ['same origin', 'https://example.com/body'],
])('still waits for critical data (%s, %s), even without a visible loader', async (_site, url) => {
    jest.useFakeTimers(); const page = new Page(); const recovery = new CloudflarePageRecovery(page);
    const request = page.request(url); let finished = false;
    const pending = recovery.settle(new Deadline(Date.now() + 30000)).then(() => { finished = true; });
    await jest.advanceTimersByTimeAsync(12000); expect(finished).toBe(false);
    page.content.fingerprint = 'the late full body'; page.emit('requestfinished', request);
    await jest.advanceTimersByTimeAsync(3000); await pending;
    expect(recovery.lastSample?.fingerprint).toBe('the late full body'); recovery.dispose();
});

test('visible loading for an external body API remains a hard barrier beyond the auxiliary window', async () => {
    jest.useFakeTimers(); const page = new Page(); const recovery = new CloudflarePageRecovery(page);
    page.content.loading = true; const request = page.request(); let finished = false;
    const pending = recovery.settle(new Deadline(Date.now() + 40000)).then(() => { finished = true; });
    await jest.advanceTimersByTimeAsync(26000); expect(finished).toBe(false);
    page.content.loading = false; page.content.fingerprint = 'loaded external body'; page.emit('requestfinished', request);
    await jest.advanceTimersByTimeAsync(6000); await pending;
    expect(recovery.lastSample?.fingerprint).toBe('loaded external body'); recovery.dispose();
});

test('a changing body needs fresh stability after critical data arrives', async () => {
    jest.useFakeTimers(); const page = new Page(); const recovery = new CloudflarePageRecovery(page);
    const request = page.request(); let finished = false;
    const pending = recovery.settle(new Deadline(Date.now() + 20000)).then(() => { finished = true; });
    await jest.advanceTimersByTimeAsync(4000); page.content.fingerprint = 'new content';
    await jest.advanceTimersByTimeAsync(4000); expect(finished).toBe(false);
    page.emit('requestfinished', request); page.content.fingerprint = 'final content';
    await jest.advanceTimersByTimeAsync(1000); expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(3000); await pending; recovery.dispose();
});

test('content stability overlaps network loading, but finishing critical data still gets a quiet interval', async () => {
    jest.useFakeTimers(); const start = Date.now(); const page = new Page(); const recovery = new CloudflarePageRecovery(page);
    const request = page.request('https://example.com/body'); let finishAt = 0;
    const pending = recovery.settle(new Deadline(Date.now() + 20000)).then(() => { finishAt = Date.now() - start; });
    await jest.advanceTimersByTimeAsync(5200); page.emit('requestfinished', request);
    await jest.advanceTimersByTimeAsync(1300); expect(finishAt).toBe(0);
    await jest.advanceTimersByTimeAsync(600); await pending;
    expect(finishAt).toBeGreaterThanOrEqual(6700); expect(finishAt).toBeLessThan(8000); recovery.dispose();
});

test('navigation clears old requests and page closure cancels the longer wait', async () => {
    jest.useFakeTimers(); const page = new Page(); const recovery = new CloudflarePageRecovery(page);
    const old = page.request(); page.emit('framenavigated', page); page.emit('requestfinished', old);
    expect(recovery.pendingCount).toBe(0);
    page.request(); const pending = recovery.settle(new Deadline(Date.now() + 20000));
    const rejected = expect(pending).rejects.toBeDefined();
    await jest.advanceTimersByTimeAsync(1000); page.emit('close'); await rejected;
    expect(page.eventNames()).toEqual([]); expect(jest.getTimerCount()).toBe(0);
});

test('an invalid request address remains conservative', async () => {
    jest.useFakeTimers(); const page = new Page(); const recovery = new CloudflarePageRecovery(page);
    page.request('not a URL');
    const pending = recovery.settle(new Deadline(Date.now() + 7000));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CF_CONTENT_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(7000); await rejected;
    expect(recovery.blockingPendingCount).toBe(1); recovery.dispose();
});
