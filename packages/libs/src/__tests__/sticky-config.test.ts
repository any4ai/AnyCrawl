import { afterEach, describe, expect, it } from '@jest/globals';
import { config } from '../config.js';
import { getBrowserRuntimeForCache } from '../cache/index.js';
const original = process.env;
afterEach(() => { process.env = original; });
describe('global sticky configuration', () => {
    it('defaults off and ignores the unused TTL', () => {
        process.env = { ...original, ANYCRAWL_PROXY_STICKY_ENABLED: 'false', ANYCRAWL_PROXY_STICKY_TTL_SECS: 'invalid' };
        expect(config.proxy.stickyEnabled).toBe(false);
        expect(config.proxy.stickyTtlSecs).toBeUndefined();
    });
    it.each(['', '0', '10', '120seconds', '1.2', '-120', '99999999999999999'])('rejects invalid enabled TTL %s', ttl => {
        process.env = { ...original, ANYCRAWL_PROXY_STICKY_ENABLED: 'true', ANYCRAWL_PROXY_STICKY_TTL_SECS: ttl };
        expect(() => config.proxy.stickyTtlSecs).toThrow('ANYCRAWL_PROXY_STICKY_TTL_SECS');
    });
    it('uses one declared window for all proxies', () => {
        process.env = { ...original, ANYCRAWL_PROXY_STICKY_ENABLED: 'true', ANYCRAWL_PROXY_STICKY_TTL_SECS: '1200' };
        expect(config.proxy.stickyTtlSecs).toBe(1200);
    });
    it('does not silently disable management on a misspelled switch', () => {
        process.env = { ...original, ANYCRAWL_PROXY_STICKY_ENABLED: 'ture' };
        expect(() => config.proxy.stickyEnabled).toThrow('must be true or false');
    });
    it('separates ordinary and isolated result cache policies without session IDs', () => {
        process.env = { ...original, ANYCRAWL_BROWSER_ISOLATE_CONTEXTS: 'true' };
        const before = getBrowserRuntimeForCache('playwright');
        process.env.ANYCRAWL_BROWSER_ISOLATE_CONTEXTS = 'false';
        expect(getBrowserRuntimeForCache('playwright')).not.toBe(before);
        const ordinary = getBrowserRuntimeForCache('playwright');
        process.env.ANYCRAWL_PROXY_STICKY_TTL_SECS = '1200';
        expect(getBrowserRuntimeForCache('playwright')).toBe(ordinary);
        expect(getBrowserRuntimeForCache('cheerio')).toBeUndefined();
    });
});
