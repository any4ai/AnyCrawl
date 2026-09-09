import { describe, it, expect } from '@jest/globals';
import { applyBrowserRecovery, freshBrowserRequestData } from '../../core/BrowserRecoveryPolicy.js';
import { StickyProxyConfigurationError } from '../../core/StickyProxyContext.js';

const context = () => ({ request: { method: 'GET', noRetry: false, userData: { options: {proxy:'auto'} } as any },
    proxyInfo: {stickyProxyTemplate:'template',stickyProxyId:'safe-id'} });
describe('browser recovery decisions', () => {
    it('gives crawl children their own deadline and original proxy permissions', () => {
        const parent = {jobId:'job',options:{proxy:'stealth'},_originalProxy:'auto',
            _anycrawlBrowserDeadlineAt:1,_anycrawlExcludedProxyIds:['old'],_proxyTier:1};
        const child = freshBrowserRequestData(parent);
        expect(child).toEqual({jobId:'job',options:{proxy:'auto'}});
        expect(parent.options.proxy).toBe('stealth');
        expect(parent._anycrawlBrowserDeadlineAt).toBe(1);
    });
    it.each([
        ['unknown error mentioning proxy and 403', 'unknown', false, 'keep'],
        ['net::ERR_PROXY_CONNECTION_FAILED', 'proxy_transport', true, 'retire'],
        ['net::ERR_INVALID_AUTH_CREDENTIALS', 'proxy_auth', true, 'retire'],
        ['ANYCRAWL_PROXY_ACTION_ROTATE_PROXY', 'challenge', true, 'exclude_origin'],
        ['Received blocked status code: 429', 'rate_limited', false, 'keep'],
        ['Navigation timed out after 30 seconds.', 'timeout', false, 'keep'],
    ])('%s has an explicit resource and retry outcome', (message, kind, retry, leaseAction) => {
        const ctx = context();
        const result = applyBrowserRecovery(ctx, new Error(message as string));
        expect(result).toMatchObject({failureKind:kind,retryAllowed:retry,leaseAction});
        expect(ctx.request.noRetry).toBe(!retry);
    });
    it('cannot revive noRetry through a stale upgrade marker', () => {
        const ctx = context(); ctx.request.noRetry = true;
        expect(applyBrowserRecovery(ctx,new Error('ANYCRAWL_PROXY_ACTION_UPGRADE_TO_STEALTH')).proxyAction).toBe('none');
        expect(ctx.request.noRetry).toBe(true);
    });
    it('does not replay non-idempotent methods or template interactions', () => {
        for (const sideEffects of [false,true]) {
            const ctx = context(); ctx.request.method = sideEffects ? 'GET' : 'POST';
            ctx.request.userData._anycrawlSideEffectsStarted = sideEffects;
            applyBrowserRecovery(ctx,new Error('net::ERR_PROXY_CONNECTION_FAILED'));
            expect(ctx.request.noRetry).toBe(true);
        }
    });
    it('configuration failures do not request rotation', () => {
        const ctx = context();
        expect(applyBrowserRecovery(ctx,new StickyProxyConfigurationError('invalid'))).toMatchObject({retryAllowed:false,proxyAction:'none'});
    });
    it('records authentication exclusion once and keeps credentials out of request state', () => {
        const ctx = context(); const error = new Error('net::ERR_PROXY_AUTH_FAILED');
        const a = applyBrowserRecovery(ctx,error), b = applyBrowserRecovery(ctx,error);
        expect(a).toBe(b);
        expect(ctx.request.userData._anycrawlExcludedProxyIds).toEqual(['safe-id']);
        expect(JSON.stringify(ctx.request.userData)).not.toContain('template');
    });
});
