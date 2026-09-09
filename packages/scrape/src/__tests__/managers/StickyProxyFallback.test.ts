import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import proxy, { resolveProxyModeWithFallback } from '../../managers/Proxy.js';
import { ProxyCacheManager } from '../../managers/ProxyCacheManager.js';
import { stickyProxySelection, stickyLeasePreference, proxyConfigurationId, proxyForCache } from '../../core/StickyProxyContext.js';
import { Utils } from '../../Utils.js';
const base = 'http://base-{sessionId}:password@base.test:8080';
const backup = 'http://backup-{sessionId}:password@backup.test:8080';
const stealth = 'http://stealth-{sessionId}:password@stealth.test:8080';
const originalEnv = process.env;
const request = (mode: string, retryCount = 0) => ({ url: 'https://target.test/', retryCount, userData: { options: { proxy: mode } } });
const select = (mode: string, retryCount = 0, proxyTier = 0) => stickyProxySelection.run(true, () => proxy.newProxyInfo('test', { request: request(mode,retryCount) as any, proxyTier }));

describe('sticky integration with existing proxy selection', () => {
    let cache: ProxyCacheManager;
    beforeEach(() => {
        process.env = { ...originalEnv, ANYCRAWL_PROXY_URL: base+','+backup, ANYCRAWL_PROXY_STEALTH_URL: stealth, ANYCRAWL_PROXY_CONFIG: '', ANYCRAWL_PROXY_STICKY_ENABLED: 'true', ANYCRAWL_PROXY_STICKY_TTL_SECS: '120' };
        cache = ProxyCacheManager.getInstance();
        jest.spyOn(cache,'getDomainCacheEntry').mockResolvedValue(null);
        jest.spyOn(cache,'getStickyDomainEntry').mockResolvedValue(null);
        jest.spyOn(cache,'isProxyFailureActive').mockResolvedValue(false);
    });
    afterEach(() => { jest.restoreAllMocks(); process.env = originalEnv; });
    it('retains configured tiers for base, auto, stealth and custom URLs', () => {
        expect(resolveProxyModeWithFallback('base')).toEqual([[base,backup]]);
        expect(resolveProxyModeWithFallback('auto')).toEqual([[base,backup],[stealth]]);
        expect(resolveProxyModeWithFallback('stealth')).toEqual([[stealth],[base,backup]]);
        expect(resolveProxyModeWithFallback(base)).toEqual([[base]]);
    });
    it('does not infer escalation from an ordinary retry', async () => {
        expect([base,backup]).toContain((await select('auto',1))?.url);
    });
    it('upgrades only on an explicit recovery action and reports the actual mode', async () => {
        const req = request('auto',1) as any;
        req.userData._anycrawlRecoveryAction = 'upgrade';
        const result = await stickyProxySelection.run(true, () => proxy.newProxyInfo('test', {request:req}));
        expect(result?.url).toBe(stealth);
        expect(req.userData.options.proxy).toBe('stealth');
        expect(req.userData._originalProxy).toBe('auto');
    });
    it('excludes failed authentication configurations without introducing a new custom pool', async () => {
        const req = request(base,1) as any;
        req.userData._anycrawlRecoveryAction = 'rotate';
        req.userData._anycrawlExcludedProxyIds = [proxyConfigurationId(base)];
        await expect(stickyProxySelection.run(true, () => proxy.newProxyInfo('test',{request:req}))).rejects.toThrow('No permitted');
    });
    it('prefers a healthy warm lease only within the selected candidates', async () => {
        const choose = jest.fn((values: string[]) => values.includes(backup) ? backup : undefined);
        const result = await stickyLeasePreference.run(choose, () => select('base'));
        expect(result?.url).toBe(backup);
        expect(choose.mock.calls[0]![0]).not.toContain(stealth);
    });
    it('ignores legacy permanent mode inference', async () => {
        jest.mocked(cache.getDomainCacheEntry).mockResolvedValue({mode:'stealth'} as any);
        expect([base,backup]).toContain((await select('auto'))?.url);
    });
    it('does not let cached stealth override the selected fallback tier', async () => {
        jest.mocked(cache.getStickyDomainEntry).mockResolvedValue({mode:'stealth',stealthWorkingProxy:stealth} as any);
        expect([base,backup]).toContain((await select('stealth',1,1))?.url);
    });
    it('does not revive old cached runtime sessions', async () => {
        jest.mocked(cache.getStickyDomainEntry).mockResolvedValue({mode:'base',baseWorkingProxy:base.replace('{sessionId}','expired')} as any);
        expect([base,backup]).toContain((await select('base'))?.url);
    });
    it('ignores cached templates removed from the configured pool', async () => {
        jest.mocked(cache.getStickyDomainEntry).mockResolvedValue({mode:'base',baseWorkingProxy:'http://removed-{sessionId}:password@removed.test:8080'} as any);
        expect([base,backup]).toContain((await select('base'))?.url);
    });
    it('keeps a valid cached template for lease allocation', async () => {
        jest.mocked(cache.getStickyDomainEntry).mockResolvedValue({mode:'base',baseWorkingProxy:backup} as any);
        expect((await select('base'))?.url).toBe(backup);
    });
    it('keeps explicit custom proxies fixed across retries', async () => {
        expect((await select(base,1,1))?.url).toBe(base);
    });
    it('persists a stable template instead of a runtime session URL', async () => {
        jest.restoreAllMocks();
        const values = new Map<string,string>();
        const redis = {get:jest.fn(async(key:string)=>values.get(key)??null),set:jest.fn(async(key:string,value:string)=>{values.set(key,value);return 'OK';})};
        jest.spyOn(Utils.getInstance(),'getRedisConnection').mockReturnValue(redis as any);
        const ctx = {proxyInfo:{url:base.replace('{sessionId}','runtime'),stickyProxyTemplate:base}};
        await cache.recordDomainSuccess('target.test',proxyForCache(ctx)!,'base');
        const entry = await cache.getDomainCacheEntry('target.test');
        expect(entry?.baseWorkingProxy).toBe(base);
        expect([...values.values()].join('')).not.toContain('runtime');
    });
    it('materializes shared templates for Cheerio without a browser lease', async () => {
        const a = await proxy.newProxyInfo('http-session',{request:request(base) as any});
        const b = await proxy.newProxyInfo('http-session',{request:request(base) as any});
        expect(a?.url).not.toContain('{sessionId}');
        expect(a?.url).not.toBe(b?.url);
        expect(a?.stickyProxyTemplate).toBe(base);
        expect(a?.username).toMatch(/^base-[a-f0-9]{16}$/);
    });
    it('materializes HttpClient URLs and preserves their explicit fallback tier', async () => {
        const url = await proxy.newUrl('http-session',{request:request('stealth',1) as any,proxyTier:1});
        expect(url).not.toContain('{sessionId}');
        expect(['base.test','backup.test']).toContain(new URL(url!).hostname);
    });
    it('keeps literal HTTP proxies unchanged when sticky is off', async () => {
        process.env.ANYCRAWL_PROXY_STICKY_ENABLED='false';
        const literal='http://fixed:password@fixed.test:8080';
        expect((await proxy.newProxyInfo('http-session',{request:request(literal) as any}))?.url).toBe(literal);
        await expect(proxy.newUrl('http-session',{request:request(base) as any})).rejects.toThrow('enable sticky');
    });
});
