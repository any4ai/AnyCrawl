import { afterEach, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Deadline } from '../../utils/Deadline.js';
import { cloudflareSession, confirmedCloudflareOrigin, disposeCloudflareContext, verifyCloudflareOnce } from '../../challenges/cloudflare/CloudflareSessionRegistry.js';

const origin = 'https://example.test';
const page = (context = new EventEmitter(), url = `${origin}/a`, driver = 'playwright') => ({
    url: () => url, ...(driver === 'playwright' ? { context: () => context } : { browserContext: () => context }),
});
const deadline = () => new Deadline(Date.now() + 10000);
const signal = () => new AbortController().signal;
const deferred = () => {
    let resolve!: (value: { cleared: boolean; code?: string; origin?: string }) => void;
    const promise = new Promise<{ cleared: boolean; code?: string; origin?: string }>(r => { resolve = r; });
    return { resolve, promise };
};
afterEach(() => { jest.useRealTimers(); });

test.each(['playwright', 'puppeteer'])('%s shares only an actual context and exact origin', async driver => {
    const context = new EventEmitter();
    const a = cloudflareSession(page(context, `${origin}/a`, driver))!;
    expect(cloudflareSession(page(context, `${origin}/b`, driver))!.state).toBe(a.state);
    expect(cloudflareSession(page(context, 'https://other.test/b', driver))!.state).not.toBe(a.state);
    expect(cloudflareSession(page(new EventEmitter(), `${origin}/b`, driver))!.state).not.toBe(a.state);
    await verifyCloudflareOnce(a, 0, deadline(), signal(), async () => ({ cleared: true, origin })).promise;
    expect(confirmedCloudflareOrigin(context, origin)).toBe(true);
    disposeCloudflareContext(context);
    expect(confirmedCloudflareOrigin(context, origin)).toBe(false);
    expect(() => cloudflareSession(page(context))).toThrow('CF_CONTEXT_CLOSED');
});

test('concurrent observers consume one success or failure, including observers delayed until completion', async () => {
    for (const cleared of [true, false]) {
        const state = cloudflareSession(page())!; const gate = deferred();
        const operation = jest.fn(async () => gate.promise);
        const leader = verifyCloudflareOnce(state, 0, deadline(), signal(), operation);
        const follower = verifyCloudflareOnce(state, 0, deadline(), signal(), operation);
        gate.resolve({ cleared, origin, code: cleared ? undefined : 'CF_NATIVE_NOT_CLEARED' });
        expect(await leader.promise).toEqual(await follower.promise);
        const late = verifyCloudflareOnce(state, 0, deadline(), signal(), operation);
        expect(await late.promise).toMatchObject({ cleared });
        expect(operation).toHaveBeenCalledTimes(1);
        expect([leader.leader, follower.leader, late.leader]).toEqual([true, false, false]);
    }
});

test('a follower deadline or cancellation leaves the owner and other followers running', async () => {
    jest.useFakeTimers();
    const session = cloudflareSession(page())!, gate = deferred(), cancel = new AbortController();
    const operation = jest.fn(async () => gate.promise);
    const owner = verifyCloudflareOnce(session, 0, deadline(), signal(), operation);
    const timed = verifyCloudflareOnce(session, 0, new Deadline(Date.now() + 100), signal(), operation);
    const cancelled = verifyCloudflareOnce(session, 0, deadline(), cancel.signal, operation);
    const timedResult = expect(timed.promise).rejects.toThrow('deadline');
    const cancelledResult = expect(cancelled.promise).rejects.toThrow('follower cancelled');
    await jest.advanceTimersByTimeAsync(100); await timedResult;
    cancel.abort(new Error('follower cancelled')); await cancelledResult;
    expect(session.state.flight).toBeDefined();
    gate.resolve({ cleared: true, origin }); await owner.promise;
    expect(operation).toHaveBeenCalledTimes(1); expect(session.state.flight).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
});

test.each(['owner', 'context'])('%s closing cancels the generation and late success cannot revive it', async kind => {
    const context = new EventEmitter(), owner = new AbortController(), gate = deferred();
    const session = cloudflareSession(page(context))!;
    const operation = jest.fn(async () => gate.promise);
    const first = verifyCloudflareOnce(session, 0, deadline(), owner.signal, operation);
    const follower = verifyCloudflareOnce(session, 0, deadline(), signal(), operation);
    if (kind === 'context') context.emit('close'); else owner.abort();
    expect(await first.promise).toMatchObject({ cleared: false, code: 'CF_CANCELLED' });
    expect(await follower.promise).toMatchObject({ cleared: false });
    gate.resolve({ cleared: true, origin }); await Promise.resolve();
    expect(confirmedCloudflareOrigin(context, origin)).toBe(false);
});

test('clearance after redirect does not certify the previous origin', async () => {
    const context = new EventEmitter(), session = cloudflareSession(page(context))!;
    await verifyCloudflareOnce(session, 0, deadline(), signal(), async () => ({ cleared: true, origin: 'https://other.test' })).promise;
    expect(confirmedCloudflareOrigin(context, origin)).toBe(false);
});
