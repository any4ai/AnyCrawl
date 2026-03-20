import { normalizeProxyUrl } from "@anycrawl/libs";
import type { HttpResponse } from "@anycrawl/libs";

export type { HttpResponse };

type HttpClientLike = {
    get: <T = any>(url: string, opts?: any) => Promise<any>;
    post: <T = any>(url: string, opts?: any) => Promise<any>;
    put: <T = any>(url: string, opts?: any) => Promise<any>;
    delete: <T = any>(url: string, opts?: any) => Promise<any>;
};

export function createHttpCrawlee(defaultProxy?: string) {
    const proxy = normalizeProxyUrl(defaultProxy);
    let clientPromise: Promise<HttpClientLike> | null = null;
    const load = async (): Promise<HttpClientLike> => {
        if (!clientPromise) {
            // @ts-ignore - Dynamic import of optional peer dependency, available at runtime
            clientPromise = import('@anycrawl/scrape').then(m => m.HttpClient as unknown as HttpClientLike);
        }
        return clientPromise;
    };
    return {
        get: async (url: string, opts?: any) => (await load()).get(url, { ...opts, proxy: opts?.proxy ?? proxy }),
        post: async (url: string, opts?: any) => (await load()).post(url, { ...opts, proxy: opts?.proxy ?? proxy }),
        put: async (url: string, opts?: any) => (await load()).put(url, { ...opts, proxy: opts?.proxy ?? proxy }),
        delete: async (url: string, opts?: any) => (await load()).delete(url, { ...opts, proxy: opts?.proxy ?? proxy }),
    };
}

