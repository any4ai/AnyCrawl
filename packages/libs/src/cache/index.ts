import { createHash } from "crypto";
import { s3Cache, getStorageConfig } from "../s3.js";
import { log } from "../log.js";

// Default cache max age: 2 days in milliseconds
export const DEFAULT_MAX_AGE = 2 * 24 * 60 * 60 * 1000;

// Cache configuration from environment
export function getCacheConfig() {
    const parseMs = (value: string | undefined, fallback: number): number => {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    const storageIsS3 = process.env.ANYCRAWL_STORAGE === 's3';
    const enabledByEnv = process.env.ANYCRAWL_CACHE_ENABLED !== 'false';
    return {
        enabled: enabledByEnv,
        pageCacheEnabled: storageIsS3 && enabledByEnv,
        mapCacheEnabled: enabledByEnv,
        defaultMaxAge: parseMs(process.env.ANYCRAWL_CACHE_DEFAULT_MAX_AGE, DEFAULT_MAX_AGE),
        sitemapMaxAge: parseMs(process.env.ANYCRAWL_CACHE_SITEMAP_MAX_AGE, 7 * 24 * 60 * 60 * 1000),
    };
}

// Parameters that affect cache key
export interface CacheKeyParams {
    url: string;
    engine?: string;
    formats?: string[];
    json_options?: object;
    include_tags?: string[];
    exclude_tags?: string[];
    proxy?: string | boolean;
    only_main_content?: boolean;
    extract_source?: string;
    ocr_options?: boolean;
    wait_for?: number;
    wait_until?: string;
    wait_for_selector?: unknown;
    template_id?: string;
    store_in_cache?: boolean;
}

// Cached content structure stored in S3
export type CachedContent = Record<string, any> & { url: string };

// Result returned from cache
export interface CachedResult extends CachedContent {
    cachedAt: Date;
    fromCache: boolean;
}

/**
 * Normalize URL for consistent cache key generation
 * - Removes trailing slashes
 * - Removes common tracking parameters
 * - Lowercases hostname
 */
export function normalizeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        // Lowercase hostname
        parsed.hostname = parsed.hostname.toLowerCase();
        // Remove trailing slash from pathname (except root)
        if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
            parsed.pathname = parsed.pathname.slice(0, -1);
        }
        // Remove common tracking parameters
        const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
        trackingParams.forEach(param => parsed.searchParams.delete(param));
        // Sort search params for consistency
        parsed.searchParams.sort();
        return parsed.toString();
    } catch {
        return url;
    }
}

/**
 * Sort object keys recursively for consistent hashing
 */
function sortKeys(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(sortKeys);
    }
    const sorted: any = {};
    Object.keys(obj).sort().forEach(key => {
        sorted[key] = sortKeys(obj[key]);
    });
    return sorted;
}

/**
 * Compute cache key from URL and options
 */
export function computeCacheKey(params: CacheKeyParams): { urlHash: string; optionsHash: string } {
    // Normalize URL
    const normalizedUrl = normalizeUrl(params.url);
    const urlHash = createHash('sha256').update(normalizedUrl).digest('hex');

    const proxyValue = params.proxy;
    const normalizedProxy = (() => {
        if (!proxyValue) return 'none';
        if (proxyValue === true) return 'true';
        if (typeof proxyValue !== 'string') return 'unknown';
        const lowered = proxyValue.toLowerCase();
        if (lowered === 'auto' || lowered === 'base' || lowered === 'stealth') return lowered;
        const proxyHash = createHash('sha256').update(proxyValue).digest('hex').slice(0, 12);
        return `custom:${proxyHash}`;
    })();

    // Extract cacheable options (sorted for consistency)
    const cacheableOptions = {
        engine: params.engine || 'cheerio',
        formats: [...(params.formats || ['markdown'])].sort(),
        json_options: params.json_options ? JSON.stringify(sortKeys(params.json_options)) : null,
        include_tags: params.include_tags ? [...params.include_tags].sort() : undefined,
        exclude_tags: params.exclude_tags ? [...params.exclude_tags].sort() : undefined,
        only_main_content: params.only_main_content ?? true,
        extract_source: params.extract_source ?? 'markdown',
        ocr_options: params.ocr_options ?? false,
        wait_for: params.wait_for ?? null,
        wait_until: params.wait_until ?? null,
        wait_for_selector: params.wait_for_selector ? JSON.stringify(sortKeys(params.wait_for_selector)) : null,
        proxy: normalizedProxy,
    };
    const optionsHash = createHash('sha256').update(JSON.stringify(cacheableOptions)).digest('hex');

    return { urlHash, optionsHash };
}

/**
 * Check if result should be cached based on options and result
 */
export function shouldCache(options: any, result: any): boolean {
    // Don't cache if explicitly disabled
    if (options?.store_in_cache === false) {
        return false;
    }
    // Don't cache template-based requests (template output may be non-deterministic / depends on variables)
    if (options?.template_id) {
        return false;
    }
    // Don't cache if custom headers are used
    if (options?.headers && Object.keys(options.headers).length > 0) {
        return false;
    }
    // Don't cache if actions are used
    if (options?.actions && options.actions.length > 0) {
        return false;
    }
    return true;
}

/**
 * Get content from S3 by key
 */
export async function getContentFromS3(s3Key: string): Promise<CachedContent | null> {
    try {
        const content = await s3Cache.get(s3Key);
        if (!content) {
            return null;
        }
        return JSON.parse(content.toString());
    } catch (error) {
        log.warning(`[CACHE] Error reading S3 content: ${error}`);
        return null;
    }
}

/**
 * Save content to S3
 */
export async function saveContentToS3(
    urlHash: string,
    result: CachedContent
): Promise<string> {
    const storageConfig = getStorageConfig();
    const now = new Date();
    const s3Key = `${storageConfig.cachePrefix}${urlHash}/${now.getTime()}.json`;

    await s3Cache.uploadJson(s3Key, result);

    return s3Key;
}

/**
 * Compute domain hash for map cache
 */
export function computeDomainHash(url: string): string {
    try {
        const parsed = new URL(url);
        const domain = parsed.hostname.toLowerCase();
        return createHash('sha256').update(domain).digest('hex');
    } catch {
        return createHash('sha256').update(url).digest('hex');
    }
}

/**
 * Map cache entry structure
 */
export interface MapCacheEntry {
    urls: Array<{ url: string; title?: string; description?: string }>;
    urlCount: number;
    source: 'sitemap' | 'search' | 'crawl' | 'combined';
    discoveredAt: Date;
}

/**
 * Map cache result
 */
export interface MapCacheResult extends MapCacheEntry {
    fromCache: boolean;
}

// Re-export for convenience
export { createHash };
