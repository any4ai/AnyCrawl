import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '@anycrawl/libs';
import { getDB } from '@anycrawl/db';
import { RequestQueueV2 } from 'crawlee';
import { EngineFactoryRegistry } from '../dist/engines/EngineFactory.js';
import { Utils } from '../dist/Utils.js';

const driver=process.argv.find(arg=>arg.startsWith('--engine='))?.slice(9);
assert(['playwright','puppeteer'].includes(driver),'Specify a driver');
assert(config.proxy.stickyEnabled,'This recovery test requires the actual sticky configuration to be enabled');
const directory=resolve('output',`sticky-recovery-${driver}-${Date.now()}`);
await mkdir(directory,{recursive:true});
const report={driver,ttlSecs:config.proxy.stickyTtlSecs,outcome:'running',faults:'explicit handler injections; real browser/proxy navigation',attempts:[]};
const save=()=>writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));
const queue=await RequestQueueV2.open(`sticky-recovery-${driver}-${Date.now()}`);
let engine,run,finished=false;
const pending=new Map();
const settle=(key,value)=>{pending.get(key)?.(value);pending.delete(key);};
try {
    engine=await EngineFactoryRegistry.createEngine(driver,queue,{
        maxConcurrency:1,autoscaledPoolOptions:{isFinishedFunction:async()=>finished},
        requestHandler:async context=>{
            const key=context.request.uniqueKey, retry=context.request.retryCount;
            const body=await context.page.evaluate(()=>document.body.innerText);
            assert(body.includes('Example Domain'),'Unexpected document');
            const row={key,retry,leaseId:context.proxyInfo?.stickyLeaseId,status:context.response.status()};
            report.attempts.push(row);await save();
            if (key==='content-timeout') throw Object.assign(new Error('CF_CONTENT_TIMEOUT'),{name:'TimeoutError'});
            if (key==='origin-rotation' && retry===0) throw new Error('ANYCRAWL_PROXY_ACTION_ROTATE_PROXY');
            if (key==='proxy-transport' && retry===0) throw new Error('net::ERR_PROXY_CONNECTION_FAILED');
            settle(key,{...row,success:true});
        },
        failedRequestHandler:async(context,error)=>settle(context.request.uniqueKey,{
            key:context.request.uniqueKey,success:false,error:error.name,noRetry:context.request.noRetry,
            retry:context.request.retryCount,leaseId:context.proxyInfo?.stickyLeaseId,
        }),
    });
    await engine.init();
    const crawler=engine.getEngine();
    assert(crawler.stickyManager);
    run=engine.run();
    const submit=async key=>{
        let timer;
        const result=new Promise(resolve=>pending.set(key,resolve));
        await queue.addRequest({url:'https://example.com/',uniqueKey:key,
            userData:{type:'temporary_scrape',options:{formats:['markdown'],store_in_cache:false,max_age:0}}});
        try {return await Promise.race([result,
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Recovery test deadline exceeded')),crawler.requestHandlerTimeoutMillis+crawler.internalTimeoutMillis);}),
            run.then(()=>{throw new Error('Crawler stopped before request result');}),
        ]);} finally {clearTimeout(timer);}
    };
    const first=await submit('baseline');assert(first.success && first.leaseId);
    const timeout=await submit('content-timeout');assert(!timeout.success && timeout.noRetry && timeout.retry===0);
    const retained=await submit('after-content-timeout');assert(retained.success);assert.equal(retained.leaseId,first.leaseId);
    const rotated=await submit('origin-rotation');assert(rotated.success && rotated.retry===1);assert.notEqual(rotated.leaseId,first.leaseId);
    const replaced=await submit('proxy-transport');assert(replaced.success && replaced.retry===1);assert.notEqual(replaced.leaseId,rotated.leaseId);
    report.results={first,timeout,retained,rotated,replaced};report.outcome='passed';
} catch(error) {report.outcome='failed';report.error=error instanceof assert.AssertionError?error.message:error.name;process.exitCode=1;}
finally {
    finished=true;
    try {
        await engine?.stop();await run;await queue.drop();
        await Utils.getInstance().redisConnection?.quit();
        const client=(await getDB()).$client;
        if (typeof client?.end==='function')await client.end();else client?.close?.();
    } catch {report.cleanupError=true;report.outcome='failed';process.exitCode=1;}
    await save();console.log(JSON.stringify({report:resolve(directory,'report.json'),outcome:report.outcome}));
}
