import { gotScraping, Request } from 'crawlee';
import proxyConfiguration from './managers/Proxy.js';
import { log, normalizeProxyUrl } from '@anycrawl/libs';
import type { HttpResponse } from '@anycrawl/libs';

export type { HttpResponse };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpClientOptions {
    headers?: Record<string, string>;
    body?: any;
    timeoutMs?: number;
    retries?: number;
    followRedirects?: boolean;
    requireProxy?: boolean; // default true
    cookieHeader?: string;
    proxy?: string; // per-request override, e.g. http://user:pass@host:port
}

export async function request<T = any>(method: HttpMethod, url: string, opts?: HttpClientOptions): Promise<HttpResponse<T>> {
    if (!url) throw new Error('Invalid URL');

    const requireProxy = opts?.requireProxy === true;

    const headers = Object.assign({}, opts?.headers);
    if (opts?.cookieHeader) headers['cookie'] = opts.cookieHeader;

    // We'll implement manual retry to rotate proxy on each attempt.
    // Keep got-scraping retries disabled to avoid reusing the same proxy within a single got call.
    const baseGsOpts: any = {
        method,
        headers,
        timeout: { request: opts?.timeoutMs ?? 20000 },
        retry: { limit: 0 },
        followRedirect: opts?.followRedirects !== false,
        throwHttpErrors: false,
    };

    if (opts?.body !== undefined) {
        if (typeof opts.body === 'object' && !(opts.body instanceof Buffer)) {
            headers['content-type'] ||= 'application/json';
            baseGsOpts.body = JSON.stringify(opts.body);
        } else {
            baseGsOpts.body = opts.body;
        }
    }

    const totalAttempts = Math.max(1, (opts?.retries ?? 2) + 1);
    let lastError: any = null;

    for (let attemptIndex = 1; attemptIndex <= totalAttempts; attemptIndex++) {
        // Determine proxy for this attempt
        let proxyUrl: string | undefined;

        // Only resolve proxy if required
        if (requireProxy) {
            proxyUrl = normalizeProxyUrl(opts?.proxy);
            if (!proxyUrl) {
                const req = new Request({ url });
                // Ask proxy configuration for a fresh proxy each attempt, stepping tiers like browser engines
                const tier = attemptIndex - 1; // 0-based tier index
                try {
                    proxyUrl = await proxyConfiguration.newUrl(undefined, { request: req, proxyTier: tier });
                } catch {
                    // Fallback to auto selection if explicit tier is invalid/unavailable
                    proxyUrl = await proxyConfiguration.newUrl(undefined, { request: req });
                }
            }
            if (!proxyUrl) {
                const e = new Error('PROXY_REQUIRED');
                e.name = 'PROXY_REQUIRED';
                throw e;
            }
        }

        const attemptOpts = { ...baseGsOpts } as any;
        if (proxyUrl) attemptOpts.proxyUrl = proxyUrl;

        try {
            const bodyLen = typeof attemptOpts.body === 'string' ? attemptOpts.body.length : (attemptOpts.body ? 1 : 0);
            log.info(`[HTTP] start method=${method} url=${url} proxy=${proxyUrl} attempt=${attemptIndex}/${totalAttempts} requireProxy=${requireProxy} timeout=${attemptOpts.timeout?.request} bodyLen=${bodyLen}`);
            const res = await gotScraping(url, attemptOpts);

            const contentType = String(res.headers['content-type'] || '');
            const flatHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
                if (typeof v === 'string') flatHeaders[k.toLowerCase()] = v;
                else if (Array.isArray(v)) flatHeaders[k.toLowerCase()] = v.join(', ');
            }
            let data: any;
            let rawText: string | undefined;
            if (/application\/json|text\/json/i.test(contentType)) {
                try { data = JSON.parse(res.body as unknown as string); } catch { data = res.body; }
            } else {
                rawText = String(res.body ?? '');
                data = rawText as unknown as T;
            }
            const size = (res.body as any)?.length ?? 0;
            log.info(`[HTTP] done method=${method} status=${res.statusCode} url=${url} proxy=${proxyUrl} ct=${contentType} bytes=${size}`);
            return { status: res.statusCode, headers: flatHeaders, data, rawText };
        } catch (err: any) {
            lastError = err;
            log.error(`[HTTP] error method=${method} url=${url} proxy=${attemptOpts?.proxyUrl} attempt=${attemptIndex}/${totalAttempts} msg=${err?.message || ''}`);
            const hasMoreAttempts = attemptIndex < totalAttempts;
            if (!hasMoreAttempts) {
                const e = new Error(`HTTP_REQUEST_ERROR ${err?.message || ''} url=${url} proxy=${attemptOpts?.proxyUrl}`.trim());
                e.name = 'HTTP_REQUEST_ERROR';
                throw e;
            }
            // Continue loop to try next proxy
        }
    }

    // Should not reach here; safeguard
    const e = new Error(`HTTP_REQUEST_ERROR ${lastError?.message || ''} url=${url}`.trim());
    e.name = 'HTTP_REQUEST_ERROR';
    throw e;
}

export const HttpClient = {
    get: <T = any>(url: string, opts?: HttpClientOptions) => request<T>('GET', url, opts),
    post: <T = any>(url: string, opts?: HttpClientOptions) => request<T>('POST', url, opts),
    put: <T = any>(url: string, opts?: HttpClientOptions) => request<T>('PUT', url, opts),
    delete: <T = any>(url: string, opts?: HttpClientOptions) => request<T>('DELETE', url, opts),
};


