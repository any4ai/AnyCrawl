import { describe, expect, jest, test } from '@jest/globals';
import { createContext, runInContext } from 'node:vm';
import { captureTurnstileBinding, injectTurnstileBinding } from '../../challenges/cloudflare/TurnstileBinding.js';

function fixture() {
    const params = { sitekey: 'widget-key', data: 'challenge-A', pagedata: 'page-A', action: 'managed' };
    const callback = jest.fn();
    const document = { querySelectorAll: () => [] };
    const window = { __anycrawlTurnstileParams: params, __anycrawlTurnstileCallback: callback, _cf_chl_opt: {} };
    const context = createContext({ URL, window, document, location: { href: 'https://example.test/' } });
    const evaluate = (fn: Function, arg: unknown) => { context.arg = arg; return runInContext(`(${fn.toString()})(arg)`, context); };
    return { params, callback, context, window, evaluate };
}

describe('document-local Turnstile task binding', () => {
    test('only the original callback is invoked, and only once', () => {
        const f = fixture(); expect(f.evaluate(captureTurnstileBinding, { id: 'job', params: f.params })).toBe(true);
        expect(f.evaluate(injectTurnstileBinding, { id: 'job', token: 'solution' })).toBe('callback:bound');
        expect(f.callback).toHaveBeenCalledTimes(1); expect(f.callback).toHaveBeenCalledWith('solution');
        expect(f.evaluate(injectTurnstileBinding, { id: 'job', token: 'second' })).toBe('stale-binding');
        expect(f.callback).toHaveBeenCalledTimes(1);
    });
    test.each(['parameters', 'callback', 'document', 'url', 'options'] as const)('rejects a %s change before callback invocation', change => {
        const f = fixture(); f.evaluate(captureTurnstileBinding, { id: 'job', params: f.params });
        const replacement = jest.fn();
        if (change === 'parameters') f.window.__anycrawlTurnstileParams = { ...f.params, data: 'challenge-B' };
        if (change === 'callback') f.window.__anycrawlTurnstileCallback = replacement;
        if (change === 'document') f.context.document = {};
        if (change === 'url') f.context.location.href = 'https://example.test/other';
        if (change === 'options') f.window._cf_chl_opt = {};
        expect(f.evaluate(injectTurnstileBinding, { id: 'job', token: 'old-solution' })).toBe('stale-binding');
        expect(f.callback).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled();
    });
    test('CF query decoration alone does not invalidate a current callback', () => {
        const f = fixture(); f.evaluate(captureTurnstileBinding, { id: 'job', params: f.params });
        f.context.location.href = 'https://example.test/?__cf_chl_rt_tk=decoration';
        expect(f.evaluate(injectTurnstileBinding, { id: 'job', token: 'solution' })).toBe('callback:bound');
        expect(f.callback).toHaveBeenCalledTimes(1);
    });
    test('a throwing callback is not reported as successful or tried twice', () => {
        const f = fixture(); f.callback.mockImplementation(() => { throw new Error('callback failed'); });
        f.evaluate(captureTurnstileBinding, { id: 'job', params: f.params });
        expect(f.evaluate(injectTurnstileBinding, { id: 'job', token: 'solution' })).toBe('callback-error');
        expect(f.evaluate(injectTurnstileBinding, { id: 'job', token: 'solution' })).toBe('stale-binding');
        expect(f.callback).toHaveBeenCalledTimes(1);
    });
    test('stale cached parameters cannot create a binding for a new live challenge', () => {
        const f = fixture();
        expect(f.evaluate(captureTurnstileBinding, { id: 'job', params: { ...f.params, data: 'old' } })).toBe(false);
    });
});
