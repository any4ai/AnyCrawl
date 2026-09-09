import { afterEach, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Deadline, DeadlineExceededError } from '../../utils/Deadline.js';
import { CloudflarePageRecovery } from '../../challenges/cloudflare/CloudflarePageRecovery.js';
afterEach(() => { jest.useRealTimers(); });
test('expired or aborted work never begins, and successful work clears its timer', async () => {
    jest.useFakeTimers(); const work = jest.fn(async () => 7);
    await expect(new Deadline(Date.now() - 1).run(work)).rejects.toBeInstanceOf(DeadlineExceededError);
    const controller = new AbortController(); controller.abort();
    await expect(new Deadline(Date.now() + 100).run(work, controller.signal)).rejects.toBeDefined();
    expect(work).not.toHaveBeenCalled();
    expect(await new Deadline(Date.now() + 100).run(work)).toBe(7);
    expect(jest.getTimerCount()).toBe(0);
});
test('CF content observation cannot outlive its deadline even if page evaluation hangs', async () => {
    jest.useFakeTimers(); const page = Object.assign(new EventEmitter(), { evaluate: jest.fn(() => new Promise(() => {})), isClosed: () => false });
    const recovery = new CloudflarePageRecovery(page);
    const pending = recovery.settle(new Deadline(Date.now() + 80)); const result = expect(pending).rejects.toBeInstanceOf(DeadlineExceededError);
    await jest.advanceTimersByTimeAsync(80); await result;
    recovery.dispose(); expect(page.eventNames()).toEqual([]); expect(jest.getTimerCount()).toBe(0);
});
test('cancellation interrupts CF polling sleep immediately', async () => {
    jest.useFakeTimers(); const controller = new AbortController();
    const pending = new Deadline(Date.now() + 5000).sleep(3000, controller.signal); const result = expect(pending).rejects.toBeDefined();
    controller.abort(); await result; expect(jest.getTimerCount()).toBe(0);
});
