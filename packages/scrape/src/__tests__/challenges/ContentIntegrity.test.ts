import { afterEach, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { classifyContent, type RecoverySample } from '../../challenges/cloudflare/ContentIntegrity.js';
import { startCloudflareRecovery, CloudflareRecoveryError } from '../../challenges/cloudflare/CloudflarePageRecovery.js';
import { ensureCloudflarePageRecovered, prepareCloudflareSnapshot } from '../../challenges/cloudflare/CloudflareChallengeHandler.js';
import { reserveCloudflareReload } from '../../challenges/cloudflare/CloudflareReload.js';
import { ensureChallengeState } from '../../challenges/ChallengeContext.js';
import { Deadline } from '../../utils/Deadline.js';
import { DataExtractor } from '../../core/DataExtractor.js';
import { applyBrowserRecovery } from '../../core/BrowserRecoveryPolicy.js';
const normal: RecoverySample = {url:'https://example.test/article',readyState:'complete',hasContent:true,loading:false,
    textLength:2,fingerprint:'short',html:'<!DOCTYPE html><html><head><title>Accepted</title></head><body><article><h1>Accepted</h1><p>Accepted body only.</p></article></body></html>'};
class Page extends EventEmitter {
    sample = {...normal};
    url = () => this.sample.url;
    mainFrame = () => this;
    isClosed = () => false;
    evaluate = jest.fn(async (fn: any, _options?: any) => fn.name === 'readRecoverySample' ? {...this.sample} : {
        url:this.url(),ready:true,hasContent:true,widget:false,challengeForm:false,challengeRuntime:false,challengeTitle:false,challengeText:false,
    });
    reload = jest.fn(async () => { this.emit('framenavigated',this); this.sample = {...normal}; return undefined; });
    network(status?: number) {
        const request={frame:()=>this,resourceType:()=> 'fetch',isNavigationRequest:()=>false,failure:()=>({errorText:'net::ERR_FAILED'})};
        this.emit('request',request);
        if(status)this.emit('response',{request:()=>request,status:()=>status,headers:()=>({}),url:()=>this.url()});
        this.emit(status?'requestfinished':'requestfailed',request);return request;
    }
}
const makeRequest = () => ({url:normal.url,method:'GET',userData:{options:{proxy:'base',formats:['html','rawHtml','text','markdown']}} as any});
function readyRequest() {const request=makeRequest();Object.assign(ensureChallengeState(request),{requiresContentRecovery:true,cleared:true,deadlineAt:Date.now()+10000});return request;}
afterEach(()=>{jest.useRealTimers();jest.restoreAllMocks();});

test('short content and unrelated failed requests are acceptable, explicit content errors are not',()=>{
    expect(classifyContent(normal,50).status).toBe('acceptable');
    expect(classifyContent({...normal,hasContent:false},1).status).toBe('unverified');
    expect(classifyContent({...normal,loading:true},1).status).toBe('loading');
    expect(classifyContent({...normal,issue:'error'},0).status).toBe('retryable_error');
    expect(classifyContent({...normal,issue:'restricted'},0).status).toBe('restricted');
});

test('failed requests leave pending but retain bounded diagnostic evidence across truncation',()=>{
    const page=new Page(), recovery=startCloudflareRecovery(page);
    for(let i=0;i<70;i++)page.network(i%2?503:undefined);
    expect(recovery.pendingCount).toBe(0);expect(recovery.failureCount).toBe(70);expect(recovery.failures).toHaveLength(64);
    const old=page.network(503);page.emit('framenavigated',page);page.emit('requestfailed',old);
    expect(recovery.failureCount).toBe(0);expect(recovery.failures).toHaveLength(0);recovery.dispose();
});

test('a content failure reloads once within the same deadline before extraction',async()=>{
    jest.useFakeTimers();const page=new Page(),request=readyRequest();const end=ensureChallengeState(request).deadlineAt;
    const recovery=startCloudflareRecovery(page);page.sample.issue='error';page.network(503);
    const pending=prepareCloudflareSnapshot({page,request});await jest.advanceTimersByTimeAsync(3000);await pending;
    expect(page.reload).toHaveBeenCalledTimes(1);expect(ensureChallengeState(request)).toMatchObject({cleared:true,contentReady:true,contentRecoveryReloads:1,contentValidationVersion:1,deadlineAt:end});
    expect(recovery.snapshot?.html).toBe(normal.html);recovery.dispose();
});

test('a second content failure is explicit and consumes no further reload or proxy action',async()=>{
    const page=new Page(),request=readyRequest(),recovery=startCloudflareRecovery(page);page.sample.issue='error';
    page.reload.mockImplementation(async()=>{page.emit('framenavigated',page);return undefined;});
    await expect(ensureCloudflarePageRecovered(page,request)).rejects.toMatchObject({code:'CF_CONTENT_INVALID'});
    expect(page.reload).toHaveBeenCalledTimes(1);expect(ensureChallengeState(request)).toMatchObject({cleared:true,contentReady:false,phase:'failed'});
    expect(applyBrowserRecovery({request},new CloudflareRecoveryError('CF_CONTENT_INVALID'))).toMatchObject({leaseAction:'keep',proxyAction:'none',retryAllowed:false});recovery.dispose();
});

test.each(['_anycrawlPreNavCaptureConfigured','_anycrawlSideEffectsStarted','_anycrawlExtractionStarted'])('%s prevents automatic content replay',async flag=>{
    const page=new Page(),request=readyRequest(),recovery=startCloudflareRecovery(page);request.userData[flag]=true;page.sample.issue='error';
    await expect(ensureCloudflarePageRecovered(page,request)).rejects.toMatchObject({code:'CF_CONTENT_INVALID'});
    expect(page.reload).not.toHaveBeenCalled();recovery.dispose();
});

test('CF, status and content repair share one reload allowance',()=>{
    const request=makeRequest();expect(reserveCloudflareReload(request,'challenge')).toBe(true);
    expect(reserveCloudflareReload(request,'content')).toBe(false);expect(reserveCloudflareReload(request,'status')).toBe(false);
    const post=makeRequest();post.method='POST';expect(reserveCloudflareReload(post,'content')).toBe(false);
});

test.each(['net::ERR_PROXY_CONNECTION_FAILED','net::ERR_PROXY_AUTH_FAILED'])('resource failure during content repair is preserved (%s)',async message=>{
    const page=new Page(),request=readyRequest(),recovery=startCloudflareRecovery(page);page.sample.issue='error';const error=new Error(message);
    page.reload.mockImplementation(async()=>{throw error;});await expect(ensureCloudflarePageRecovered(page,request)).rejects.toBe(error);
    expect((request as any).__anycrawlContentRecoveryError).toBe(error);
    expect(applyBrowserRecovery({request},error).leaseAction).toBe('retire');recovery.dispose();
});

test('a confirmed broken resource is retired even when the request deadline disallows retry',()=>{
    const request=readyRequest();request.userData._anycrawlBrowserDeadlineAt=Date.now()-1;
    Object.assign(ensureChallengeState(request),{phase:'failed',lastError:{code:'CF_CONTENT_INVALID'}});
    expect(applyBrowserRecovery({request},new Error('net::ERR_PROXY_CONNECTION_FAILED'))).toMatchObject({leaseAction:'retire',retryAllowed:false,proxyAction:'none'});
});

test('snapshot capture rejects changes occurring between stability and serialization',async()=>{
    jest.useFakeTimers();const page=new Page(),recovery=startCloudflareRecovery(page);let changed=false;
    page.evaluate.mockImplementation(async(fn:any, options?:any)=>{
        if(fn.name!=='readRecoverySample')return {url:page.url(),ready:true,hasContent:true} as any;
        if(options?.captureHtml&&!changed){changed=true;page.sample.fingerprint='new document text';page.sample.html=normal.html!.replaceAll('Accepted','Updated');}
        return {...page.sample};
    });
    const pending=prepareCloudflareSnapshot({page,request:readyRequest()});await jest.advanceTimersByTimeAsync(6000);await pending;
    expect(recovery.snapshot?.html).toContain('Updated');expect(recovery.snapshot?.sample.fingerprint).toBe('new document text');recovery.dispose();
});

test('all HTML-derived formats consume the accepted snapshot without a second live read',async()=>{
    jest.useFakeTimers();const page=new Page(),request=readyRequest(),recovery=startCloudflareRecovery(page);
    const context:any={page,request,parseWithCheerio:jest.fn(async()=>{throw new Error('must not read a newer document');})};
    const pending=prepareCloudflareSnapshot(context);await jest.advanceTimersByTimeAsync(3000);await pending;
    page.sample.html='<html><body>WRONG LATER DOCUMENT</body></html>';
    const data=await new DataExtractor().extractData(context);
    expect(data.rawHtml).toBe(normal.html);expect(data.html).toContain('Accepted body');expect(data.markdown).toContain('Accepted body');expect(data.text).toContain('Accepted body');
    expect(context.parseWithCheerio).not.toHaveBeenCalled();expect(data.rawHtml).not.toContain('WRONG');recovery.dispose();
});

test('a required missing snapshot fails with the content error code intact',async()=>{
    const request=readyRequest();const context:any={request,page:new Page()};
    await expect(new DataExtractor().extractData(context)).rejects.toMatchObject({code:'CF_CONTENT_UNVERIFIED'});
});

test('started format work cannot be replayed through an outer resource retry',()=>{
    const request=readyRequest();request.userData._anycrawlExtractionStarted=true;
    expect(applyBrowserRecovery({request},new Error('net::ERR_PROXY_CONNECTION_FAILED'))).toMatchObject({leaseAction:'retire',retryAllowed:false,proxyAction:'none'});
});

test('new network activity during serialization invalidates the candidate snapshot',async()=>{
    jest.useFakeTimers();const page=new Page(),recovery=startCloudflareRecovery(page);let once=false;
    page.evaluate.mockImplementation(async(fn:any, options?:any)=>{
        if(fn.name!=='readRecoverySample')return {url:page.url(),ready:true,hasContent:true} as any;
        if(options?.captureHtml&&!once){once=true;page.network(200);page.sample.fingerprint='updated';page.sample.html=normal.html!.replaceAll('Accepted','Current');}
        return {...page.sample};
    });
    const pending=prepareCloudflareSnapshot({page,request:readyRequest()});await jest.advanceTimersByTimeAsync(7000);await pending;
    expect(recovery.snapshot?.html).toContain('Current');expect(recovery.snapshot?.networkRevision).toBe(recovery.networkRevision);recovery.dispose();
});

test('closing during snapshot capture cancels instead of returning an earlier successful sample',async()=>{
    jest.useFakeTimers();const page=new Page(),recovery=startCloudflareRecovery(page);
    page.evaluate.mockImplementation(async(fn:any,options?:any)=>{
        if(fn.name!=='readRecoverySample')return {url:page.url(),ready:true,hasContent:true} as any;
        if(options?.captureHtml)return new Promise<any>(()=>{});
        return {...page.sample};
    });
    const request=readyRequest(),pending=prepareCloudflareSnapshot({page,request});const rejected=expect(pending).rejects.toMatchObject({code:'CF_CANCELLED'});
    await jest.advanceTimersByTimeAsync(2500);page.emit('close');await rejected;
    expect(ensureChallengeState(request).contentReady).toBe(false);expect(page.listenerCount('requestfailed')).toBe(0);
});

test('a real main-response 407 after content reload remains proxy authentication failure',async()=>{
    const page=new Page(),request=readyRequest(),recovery=startCloudflareRecovery(page);page.sample.issue='error';
    page.reload.mockImplementation(async()=>{page.emit('framenavigated',page);page.sample={...normal};return {status:()=>407,headers:()=>({}),url:()=>page.url()} as any;});
    await expect(ensureCloudflarePageRecovered(page,request)).rejects.toMatchObject({statusCode:407});
    const error=(request as any).__anycrawlContentRecoveryError;
    expect(applyBrowserRecovery({request},error)).toMatchObject({failureKind:'proxy_auth',leaseAction:'retire'});recovery.dispose();
});

test('ordinary extraction never consumes a CF-only snapshot left on a caller context',async()=>{
    const request=makeRequest();const context:any={request,body:Buffer.from('<html><body><p>Current ordinary page</p></body></html>'),
        __anycrawlVerifiedContentSnapshot:{version:1,html:normal.html}};
    const data=await new DataExtractor().extractData(context);
    expect(data.rawHtml).toContain('Current ordinary page');expect(data.rawHtml).not.toContain('Accepted body');
});
