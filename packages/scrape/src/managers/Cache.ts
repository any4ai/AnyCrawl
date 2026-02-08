import { log } from "crawlee";
import { getDB, schemas, eq, gt, and } from "@anycrawl/db";
import { desc } from "drizzle-orm";
import { computeCacheKey, shouldCache, getCacheConfig, getContentFromS3, saveContentToS3, computeDomainHash } from "@anycrawl/libs";
import type { CachedResult, CachedContent, CacheKeyParams, MapCacheEntry, MapCacheResult } from "@anycrawl/libs";
import { createHash } from "crypto";

/**
 * Cache Manager for handling page cache operations
 */
export class CacheManager {
    private static instance: CacheManager;

    private constructor() {}

    public static getInstance(): CacheManager {
        if (!CacheManager.instance) {
            CacheManager.instance = new CacheManager();
        }
        return CacheManager.instance;
    }

    /**
     * Get cached result from database and S3
     */
    async getFromCache(
        url: string,
        options: CacheKeyParams,
        maxAge?: number
    ): Promise<CachedResult | null> {
        const config = getCacheConfig();
        if (!config.pageCacheEnabled) {
            return null;
        }

        const effectiveMaxAge = maxAge ?? config.defaultMaxAge;

        // max_age = 0 means force refresh, skip cache
        if (effectiveMaxAge === 0) {
            return null;
        }

        try {
            const { urlHash, optionsHash } = computeCacheKey({ ...options, url });
            const minScrapedAt = new Date(Date.now() - effectiveMaxAge);

            const db = await getDB();
            const [cached] = await db
                .select()
                .from(schemas.pageCache)
                .where(and(
                    eq(schemas.pageCache.urlHash, urlHash),
                    eq(schemas.pageCache.optionsHash, optionsHash),
                    gt(schemas.pageCache.scrapedAt, minScrapedAt)
                ))
                .orderBy(desc(schemas.pageCache.scrapedAt))
                .limit(1);

            if (!cached) {
                return null;
            }

            // Get content from S3
            const content = await getContentFromS3(cached.s3Key);
            if (!content) {
                log.warning(`[CACHE] S3 content not found for key: ${cached.s3Key}`);
                return null;
            }

            log.info(`[CACHE] Cache hit for ${url} (cached at ${cached.scrapedAt.toISOString()})`);

            return {
                ...content,
                cachedAt: cached.scrapedAt,
                fromCache: true,
            };
        } catch (error) {
            log.warning(`[CACHE] Error reading cache for ${url}: ${error}`);
            return null;
        }
    }

    /**
     * Save result to cache (database and S3)
     */
    async saveToCache(
        url: string,
        options: CacheKeyParams,
        result: CachedContent,
        pageMetadata?: {
            statusCode?: number;
            contentType?: string;
            contentLength?: number;
        }
    ): Promise<void> {
        const config = getCacheConfig();
        if (!config.pageCacheEnabled) {
            return;
        }

        const statusCode = pageMetadata?.statusCode;
        // Don't cache non-success responses (also skips "no response" statusCode=0)
        if (typeof statusCode === "number" && (statusCode === 0 || statusCode >= 400)) {
            return;
        }

        // Check if should cache
        if (!shouldCache(options, result)) {
            return;
        }

        try {
            const { urlHash, optionsHash } = computeCacheKey({ ...options, url });
            const domain = new URL(url).hostname.toLowerCase();
            const now = new Date();

            // Save to S3
            const s3Key = await saveContentToS3(urlHash, result);

            const title = typeof (result as any).title === "string" ? String((result as any).title).trim() : null;
            const description = (() => {
                const meta = (result as any).metadata;
                if (!Array.isArray(meta)) return null;
                const candidates = [
                    (e: any) => (e?.name || "").toLowerCase() === "description",
                    (e: any) => (e?.property || "").toLowerCase() === "og:description",
                    (e: any) => (e?.name || "").toLowerCase() === "twitter:description",
                ];
                for (const match of candidates) {
                    const found = meta.find(match);
                    const content = typeof found?.content === "string" ? found.content.trim() : "";
                    if (content) return content;
                }
                return null;
            })();

            const contentForHash =
                typeof (result as any).html === "string"
                    ? (result as any).html
                    : typeof (result as any).rawHtml === "string"
                        ? (result as any).rawHtml
                        : typeof (result as any).markdown === "string"
                            ? (result as any).markdown
                            : typeof (result as any).text === "string"
                                ? (result as any).text
                                : null;
            const contentHash = contentForHash
                ? createHash("sha256").update(contentForHash).digest("hex")
                : null;
            const contentLength =
                typeof pageMetadata?.contentLength === "number" && pageMetadata.contentLength > 0
                    ? pageMetadata.contentLength
                    : contentForHash
                        ? Buffer.byteLength(contentForHash, "utf8")
                        : null;
            const contentType =
                typeof pageMetadata?.contentType === "string" && pageMetadata.contentType.trim()
                    ? pageMetadata.contentType.trim()
                    : null;
            const hasScreenshot = !!((result as any).screenshot || (result as any)["screenshot@fullPage"]);

            // Upsert to database
            const db = await getDB();
            await db
                .insert(schemas.pageCache)
                .values({
                    url,
                    urlHash,
                    domain,
                    s3Key,
                    contentHash,
                    title,
                    description,
                    statusCode: statusCode ?? 200,
                    contentType,
                    contentLength,
                    optionsHash,
                    engine: options.engine,
                    hasProxy: !!options.proxy,
                    hasScreenshot,
                    scrapedAt: now,
                })
                .onConflictDoUpdate({
                    target: [schemas.pageCache.urlHash, schemas.pageCache.optionsHash],
                    set: {
                        s3Key,
                        contentHash,
                        title,
                        description,
                        statusCode: statusCode ?? 200,
                        contentType,
                        contentLength,
                        scrapedAt: now,
                    },
                });

            log.info(`[CACHE] Saved cache for ${url}`);
        } catch (error) {
            log.warning(`[CACHE] Error saving cache for ${url}: ${error}`);
        }
    }

    /**
     * Check if caching is enabled
     */
    isEnabled(): boolean {
        return getCacheConfig().enabled;
    }

    // ==================== Map Cache Methods ====================

    /**
     * Get cached map result from database
     */
    async getMapFromCache(
        url: string,
        source: 'sitemap' | 'search' | 'crawl' | 'combined',
        maxAge?: number
    ): Promise<MapCacheResult | null> {
        const config = getCacheConfig();
        if (!config.mapCacheEnabled) {
            return null;
        }

        const effectiveMaxAge = maxAge ?? (source === 'sitemap' ? config.sitemapMaxAge : config.defaultMaxAge);

        // max_age = 0 means force refresh, skip cache
        if (effectiveMaxAge === 0) {
            return null;
        }

        try {
            const domainHash = computeDomainHash(url);
            const minDiscoveredAt = new Date(Date.now() - effectiveMaxAge);

            const db = await getDB();
            const [cached] = await db
                .select()
                .from(schemas.mapCache)
                .where(and(
                    eq(schemas.mapCache.domainHash, domainHash),
                    eq(schemas.mapCache.source, source),
                    gt(schemas.mapCache.discoveredAt, minDiscoveredAt)
                ))
                .orderBy(desc(schemas.mapCache.discoveredAt))
                .limit(1);

            if (!cached) {
                return null;
            }

            log.info(`[CACHE] Map cache hit for ${url} source=${source} (cached at ${cached.discoveredAt.toISOString()})`);

            return {
                urls: cached.urls as Array<{ url: string; title?: string; description?: string }>,
                urlCount: cached.urlCount,
                source: cached.source as 'sitemap' | 'search' | 'crawl' | 'combined',
                discoveredAt: cached.discoveredAt,
                fromCache: true,
            };
        } catch (error) {
            log.warning(`[CACHE] Error reading map cache for ${url}: ${error}`);
            return null;
        }
    }

    /**
     * Save map result to cache
     */
    async saveMapToCache(
        url: string,
        source: 'sitemap' | 'search' | 'crawl' | 'combined',
        urls: Array<{ url: string; title?: string; description?: string }>
    ): Promise<void> {
        const config = getCacheConfig();
        if (!config.mapCacheEnabled) {
            return;
        }

        try {
            const parsed = new URL(url);
            const domain = parsed.hostname.toLowerCase();
            const domainHash = computeDomainHash(url);
            const now = new Date();

            const db = await getDB();
            await db
                .insert(schemas.mapCache)
                .values({
                    domain,
                    domainHash,
                    urls,
                    urlCount: urls.length,
                    source,
                    discoveredAt: now,
                })
                .onConflictDoUpdate({
                    target: [schemas.mapCache.domainHash, schemas.mapCache.source],
                    set: {
                        urls,
                        urlCount: urls.length,
                        discoveredAt: now,
                    },
                });

            log.info(`[CACHE] Saved map cache for ${domain} source=${source} (${urls.length} URLs)`);
        } catch (error) {
            log.warning(`[CACHE] Error saving map cache for ${url}: ${error}`);
        }
    }

    /**
     * Get URLs from page_cache index for a domain
     */
    async getUrlsFromPageCacheIndex(
        url: string,
        limit: number = 5000
    ): Promise<Array<{ url: string; title?: string; description?: string }>> {
        const config = getCacheConfig();
        if (!config.pageCacheEnabled) {
            return [];
        }
        try {
            const parsed = new URL(url);
            const domain = parsed.hostname.toLowerCase();

            const db = await getDB();
            const results = await db
                .select({
                    url: schemas.pageCache.url,
                    title: schemas.pageCache.title,
                    description: schemas.pageCache.description,
                })
                .from(schemas.pageCache)
                .where(eq(schemas.pageCache.domain, domain))
                .orderBy(desc(schemas.pageCache.scrapedAt))
                .limit(limit);

            return results.map((r: { url: string; title: string | null; description: string | null }) => ({
                url: r.url,
                title: r.title ?? undefined,
                description: r.description ?? undefined,
            }));
        } catch (error) {
            log.warning(`[CACHE] Error getting URLs from page cache index: ${error}`);
            return [];
        }
    }
}
