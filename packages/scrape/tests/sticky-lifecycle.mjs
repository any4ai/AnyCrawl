// Run after the production build, under the same dotenv-run configuration as the worker.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { config } from '@anycrawl/libs';
import { RequestQueueV2 } from 'crawlee';
import { EngineFactoryRegistry } from '../dist/engines/EngineFactory.js';
import { getDB } from '@anycrawl/db';
import { Utils } from '../dist/Utils.js';

const engineType = process.argv.find(arg => arg.startsWith('--engine='))?.slice(9);
assert(['playwright','puppeteer'].includes(engineType), 'Specify --engine=playwright or --engine=puppeteer; drivers are tested independently');
const url = process.env.ANYCRAWL_STICKY_E2E_URL || 'https://example.com/';
const reportDir = resolve(process.cwd(), 'output', `sticky-${engineType}-${Date.now()}`);
await mkdir(reportDir,{recursive:true});
const report = {engine:engineType,platform:process.platform,startedAt:new Date().toISOString(),
    stickyEnabled:config.proxy.stickyEnabled,ttlSecs:config.proxy.stickyTtlSecs ?? null,
    isolateContexts:config.engine.browserIsolateContexts,keepAlive:config.engine.keepAlive,
    outcome:'running',ttlOutcome:config.proxy.stickyEnabled ? 'pending' : 'not_applicable',requests:[],history:[]};
const save = () => writeFile(resolve(reportDir,'report.json'),JSON.stringify(report,null,2));
await save();
let engine, queue, run, timer;
let finished=false;
const waiting=new Map();
const failure = new AbortController();
const settleRequest = (key,error,value) => { const waiter=waiting.get(key); if (!waiter) return;
    waiting.delete(key); error ? waiter.reject(error) : waiter.resolve(value); };
try {
    queue=await RequestQueueV2.open(`sticky-e2e-${engineType}-${Date.now()}`);
    engine=await EngineFactoryRegistry.createEngine(engineType,queue,{
        maxConcurrency:1,
        // Test termination only. Proxy, context, TTL, pool retirement and request budgets stay configured.
        autoscaledPoolOptions:{isFinishedFunction:async()=>finished},
        requestHandler:async context=>{
            const page=context.page;
            const title=await page.title();
            const content=await page.evaluate(()=>document.body?.innerText?.trim() ?? '');
            assert(content.length>0,'Empty document');
            if (url === 'https://example.com/') assert(content.includes('Example Domain'),'Expected example.com document was not returned');
            const status=context.response?.status();
            assert(status>=200 && status<400,`HTTP status ${status}`);
            let exitIpHash;
            if (report.stickyEnabled) {
                // Observe the actual browser's exit, with a unique URL to avoid cached IP evidence.
                const probe=await page.goto(`https://api.ipify.org/?format=json&probe=${Date.now()}`,{
                    timeout:config.navigation.timeoutMs,waitUntil:'domcontentloaded'});
                assert.equal(probe?.status(),200,'IP probe failed');
                const ip=JSON.parse(await page.evaluate(()=>document.body.innerText)).ip;
                assert(isIP(ip),'IP probe did not return an IP address');
                exitIpHash=createHash('sha256').update(ip).digest('hex');
                const restored=await page.goto(url,{timeout:config.navigation.timeoutMs,waitUntil:'domcontentloaded'});
                assert(restored?.status()>=200 && restored?.status()<400,'Document restore after IP probe failed');
            }
            const result={key:context.request.uniqueKey,status,title,contentLength:content.length,
                leaseId:context.proxyInfo?.stickyLeaseId ?? null,exitIpHash,time:Date.now()};
            report.requests.push(result); await save();
            settleRequest(context.request.uniqueKey,null,result);
        },
        failedRequestHandler:async(context,error)=>{
            report.requests.push({key:context.request.uniqueKey,error:error.name,time:Date.now()});
            settleRequest(context.request.uniqueKey,new Error(`Request failed: ${error.name}`));
        },
    });
    await engine.init();
    const crawler=engine.getEngine();
    const manager=crawler.stickyManager;
    assert.equal(Boolean(manager),report.stickyEnabled,'Configured sticky state must match the instantiated crawler');
    const requestBudget=crawler.requestHandlerTimeoutMillis;
    const cleanupBudget=crawler.internalTimeoutMillis;
    assert(Number.isFinite(requestBudget) && requestBudget>0 && Number.isFinite(cleanupBudget) && cleanupBudget>0);
    report.requestBudgetMs=requestBudget;
    const totalBudget=requestBudget*2+(report.ttlSecs ?? 0)*1000+cleanupBudget;
    report.testBudgetMs=totalBudget;
    timer=setTimeout(()=>failure.abort(new Error('Configured E2E observation budget exhausted')),totalBudget);
    const aborted=new Promise((_,reject)=>failure.signal.addEventListener('abort',()=>reject(failure.signal.reason),{once:true}));
    // Attach immediately, even if initialization fails before the first request.
    aborted.catch(()=>{});
    const request=async key=>{
        const result=new Promise((resolve,reject)=>waiting.set(key,{resolve,reject}));
        await queue.addRequest({url,uniqueKey:key,userData:{type:'temporary_scrape',options:{formats:['markdown'],store_in_cache:false,max_age:0}}});
        return Promise.race([result,aborted]);
    };
    run=engine.run();
    run.catch(error=>failure.abort(error));
    const first=await request('before-expiry');
    if (manager) {
        const lease=manager.snapshot().find(item=>item.id===first.leaseId);
        assert(lease,'No managed proxy lease was used; cannot validate configured sticky lifetime');
        report.observedLease=lease;
        await save();
        const until=lease.createdAt+report.ttlSecs*1000;
        const probeInterval=Math.max(1000,Math.min(300000,report.ttlSecs*250,config.engine.browserIdleRetireSecs*500));
        report.probeIntervalMs=probeInterval;
        let nextProbe=performance.now()+probeInterval, probeCount=0;
        while (performance.now()<until) {
            await Promise.race([sleep(Math.min(30000,until-performance.now())),aborted]);
            report.history=manager.lifecycleHistory(); await save();
            if (performance.now()>=nextProbe && performance.now()+requestBudget<lease.safeUntil) {
                const sample=await request(`reuse-${++probeCount}`);
                assert.equal(sample.leaseId,first.leaseId,'Lease retired before its natural expiry');
                assert.equal(sample.exitIpHash,first.exitIpHash,'Exit IP changed inside the sticky window');
                nextProbe=performance.now()+probeInterval;
            }
            console.log(JSON.stringify({event:'observing',remainingMs:Math.max(0,until-performance.now())}));
        }
        report.history=manager.lifecycleHistory();
        const retired=report.history.find(item=>item.id===lease.id);
        assert(retired?.retireReason==='ttl',`Natural expiry not observed: ${retired?.retireReason ?? 'not closed'}`);
        const next=await request('after-expiry');
        assert(next.leaseId && next.leaseId!==first.leaseId,'Expired identity was reused');
        assert(!manager.snapshot().some(item=>item.id===first.leaseId),'Expired lease remains allocated');
        report.ttlOutcome='passed';
    } else {
        const next=await request('sticky-disabled');
        assert.equal(first.leaseId,null); assert.equal(next.leaseId,null);
    }
    report.outcome='passed';
} catch(error) {
    report.outcome='failed';
    if (report.ttlOutcome==='pending') report.ttlOutcome='not_completed';
    report.error=error instanceof assert.AssertionError ? error.message : error.name;
    process.exitCode=1;
} finally {
    clearTimeout(timer); finished=true;
    try {
        await engine?.stop(); await run; await queue?.drop();
        // This standalone test owns these process-local clients. Do not force process.exit over open connections.
        await Utils.getInstance().redisConnection?.quit();
        const client=(await getDB()).$client;
        if (typeof client?.end === 'function') await client.end();
        else if (typeof client?.close === 'function') client.close();
    }
    catch { report.outcome='failed'; report.cleanupError=true; process.exitCode=1; }
    report.completedAt=new Date().toISOString(); await save();
    console.log(JSON.stringify({report:resolve(reportDir,'report.json'),outcome:report.outcome,ttlOutcome:report.ttlOutcome}));
}
