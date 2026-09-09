import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProxyCacheManager } from '../dist/managers/ProxyCacheManager.js';
import { Utils } from '../dist/Utils.js';
import { getDB } from '@anycrawl/db';

// Exercise Redis's actual Lua/CAS semantics in a unique, disposable namespace.
const prefix=`anycrawl:test:sticky:${randomUUID()}:`;
ProxyCacheManager.resetInstance();
const cache=ProxyCacheManager.getInstance({redisKeyPrefix:prefix});
const redis=Utils.getInstance().getRedisConnection();
const domain='sticky-cache.invalid';
const legacy=`${prefix}domain:${domain}`, key=`${prefix}sticky:v2:${domain}`;
const template='http://session-{sessionId}:test@proxy.invalid:8080';
try {
    await redis.set(legacy,JSON.stringify({mode:'stealth'}));
    assert.equal(await cache.getStickyDomainEntry(domain),null);
    const now=Date.now();
    await cache.recordStickySuccess(domain,template,'stealth',false,now);
    assert.equal((await cache.getStickyDomainEntry(domain)).mode,'base');
    await cache.recordStickySuccess(domain,template,'stealth',true,now+2);
    await cache.recordStickySuccess(domain,template,'base',false,now+1);
    const entry=await cache.getStickyDomainEntry(domain);
    assert.equal(entry.mode,'stealth','Older results must not replace newer evidence');
    assert.equal(entry.updatedAt,now+2);
    assert.equal(entry.stealthWorkingProxy,template);
    const ttl=await redis.ttl(key);
    assert(ttl>0 && ttl<=1800,'Sticky evidence must expire');
    assert.equal(await redis.get(legacy),JSON.stringify({mode:'stealth'}));
    console.log(JSON.stringify({outcome:'passed',checks:['legacy-isolation','upgrade-evidence','atomic-ordering','expiry','stable-template']}));
} finally {
    await redis.del(legacy,key);
    await redis.quit();
    const client=(await getDB()).$client;
    if (typeof client?.end==='function') await client.end();
    else client?.close?.();
}
