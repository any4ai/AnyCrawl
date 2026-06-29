import { getDB, schemas, eq, gt, and, desc } from "@anycrawl/db";
import {
    computeArtifactOptionsHash,
    computeCacheKey,
    computeDomainHash,
    computeSnapshotKey,
    getCacheConfig,
    getContentFromS3,
    log,
    normalizeProxyForCache,
    normalizeUrl,
    saveContentToS3,
    shouldCache,
} from "@anycrawl/libs";
import type {
    CacheArtifactType,
    CachedContent,
    CachedResult,
    CacheKeyParams,
    MapCacheEntry,
    MapCacheResult,
} from "@anycrawl/libs";
import { getExtractModelId } from "@anycrawl/ai";
import { createHash, randomUUID } from "crypto";

type StorageMode = "db" | "s3";

interface PageCacheArtifactValue {
    type: CacheArtifactType;
    value: unknown;
    optionsHash: string;
    storageMode: StorageMode;
    contentBytes: number;
    contentHash: string;
    s3Key?: string;
}

const DB_ARTIFACT_TYPES = new Set<CacheArtifactType>([
    "base",
    "markdown",
    "text",
    "links",
    "json",
    "summary",
    "screenshot",
    "screenshot@fullPage",
]);

const S3_FIRST_ARTIFACT_TYPES = new Set<CacheArtifactType>(["html", "rawHtml"]);

function getArtifactCacheConfig() {
    const cacheConfig = getCacheConfig() as any;
    const parsedDbArtifactMaxBytes = Number.parseInt(process.env.ANYCRAWL_CACHE_DB_ARTIFACT_MAX_BYTES || "", 10);
    return {
        artifactsEnabled: cacheConfig.artifactsEnabled ?? process.env.ANYCRAWL_CACHE_ARTIFACTS_ENABLED !== "false",
        legacyFallbackEnabled: cacheConfig.legacyFallbackEnabled ?? process.env.ANYCRAWL_CACHE_LEGACY_FALLBACK_ENABLED !== "false",
        legacyWriteEnabled: cacheConfig.legacyWriteEnabled ?? process.env.ANYCRAWL_CACHE_LEGACY_WRITE_ENABLED === "true",
        dbArtifactMaxBytes: cacheConfig.dbArtifactMaxBytes ?? (Number.isFinite(parsedDbArtifactMaxBytes) ? parsedDbArtifactMaxBytes : 1024 * 1024),
    };
}

function getRequestedFormats(options: CacheKeyParams): CacheArtifactType[] {
    const formats = Array.isArray(options.formats) && options.formats.length > 0 ? options.formats : ["markdown"];
    return formats.filter((format): format is CacheArtifactType =>
        format === "markdown" ||
        format === "html" ||
        format === "rawHtml" ||
        format === "text" ||
        format === "links" ||
        format === "json" ||
        format === "summary" ||
        format === "screenshot" ||
        format === "screenshot@fullPage"
    );
}

function jsonByteLength(value: unknown): number {
    if (typeof value === "string") {
        return Buffer.byteLength(value, "utf8");
    }
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function hashArtifactValue(value: unknown): string {
    return createHash("sha256")
        .update(typeof value === "string" ? value : JSON.stringify(value))
        .digest("hex");
}

function extractDescription(result: any): string | null {
    const meta = result?.metadata;
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
}

function buildBaseArtifact(result: CachedContent): Record<string, unknown> {
    const base: Record<string, unknown> = {};
    for (const key of ["url", "title", "metadata", "timestamp", "jobId", "proxy", "status"]) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            base[key] = (result as any)[key];
        }
    }
    return base;
}

function getArtifactModelId(type: CacheArtifactType): string | null {
    return type === "json" || type === "summary" ? getExtractModelId() : null;
}

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

    private getArtifactTypesForRead(options: CacheKeyParams): CacheArtifactType[] {
        return ["base", ...getRequestedFormats(options)];
    }

    private getArtifactTypesForWrite(result: CachedContent): CacheArtifactType[] {
        const artifacts: CacheArtifactType[] = ["base"];
        for (const type of ["markdown", "html", "rawHtml", "text", "links", "json", "summary", "screenshot", "screenshot@fullPage"] as CacheArtifactType[]) {
            if (Object.prototype.hasOwnProperty.call(result, type)) {
                artifacts.push(type);
            }
        }
        return artifacts;
    }

    private getArtifactValue(type: CacheArtifactType, result: CachedContent): unknown {
        return type === "base" ? buildBaseArtifact(result) : (result as any)[type];
    }

    private async readArtifactValue(artifact: any): Promise<unknown | undefined> {
        if (artifact.storageMode === "db") {
            if (artifact.contentText !== null && artifact.contentText !== undefined) {
                return artifact.contentText;
            }
            return artifact.contentJson;
        }
        if (artifact.storageMode === "s3" && artifact.s3Key) {
            const content = await getContentFromS3(artifact.s3Key);
            if (!content || typeof content !== "object" || !("value" in content)) {
                return undefined;
            }
            return (content as any).value;
        }
        return undefined;
    }

    private shouldStoreArtifactInDb(type: CacheArtifactType, value: unknown, maxDbBytes: number): boolean {
        if (S3_FIRST_ARTIFACT_TYPES.has(type)) {
            return false;
        }
        if (!DB_ARTIFACT_TYPES.has(type)) {
            return false;
        }
        return jsonByteLength(value) <= maxDbBytes;
    }

    private async getFromArtifactCache(
        url: string,
        options: CacheKeyParams,
        effectiveMaxAge: number
    ): Promise<CachedResult | null> {
        const artifactConfig = getArtifactCacheConfig();
        if (!artifactConfig.artifactsEnabled) {
            return null;
        }

        const { snapshotHash } = computeSnapshotKey({ ...options, url });
        const minScrapedAt = new Date(Date.now() - effectiveMaxAge);
        const db = await getDB();
        const [entry] = await db
            .select()
            .from(schemas.pageCacheEntries)
            .where(and(
                eq(schemas.pageCacheEntries.snapshotHash, snapshotHash),
                gt(schemas.pageCacheEntries.scrapedAt, minScrapedAt)
            ))
            .orderBy(desc(schemas.pageCacheEntries.scrapedAt))
            .limit(1);

        if (!entry) {
            return null;
        }

        const requestedArtifacts = this.getArtifactTypesForRead(options);
        const requestedOptionHashes = new Map(
            requestedArtifacts.map((type) => [
                type,
                computeArtifactOptionsHash({ ...options, url, artifactType: type, modelId: getArtifactModelId(type) }),
            ])
        );

        const artifacts = await db
            .select()
            .from(schemas.pageCacheArtifacts)
            .where(and(
                eq(schemas.pageCacheArtifacts.entryUuid, entry.uuid),
                gt(schemas.pageCacheArtifacts.scrapedAt, minScrapedAt)
            ));
        const artifactByKey = new Map<string, any>();
        for (const artifact of artifacts) {
            artifactByKey.set(`${artifact.artifactType}:${artifact.artifactOptionsHash}`, artifact);
        }

        const assembled: Record<string, any> = {};
        for (const type of requestedArtifacts) {
            const artifact = artifactByKey.get(`${type}:${requestedOptionHashes.get(type)}`);
            if (!artifact) {
                log.info(`[CACHE] Artifact miss for ${url} type=${type}`);
                return null;
            }
            const value = await this.readArtifactValue(artifact);
            if (value === undefined) {
                log.warning(`[CACHE] Artifact content missing for ${url} type=${type}`);
                return null;
            }
            if (type === "base") {
                Object.assign(assembled, value);
            } else {
                assembled[type] = value;
            }
        }

        if (!shouldCache({}, assembled)) {
            log.warning(`[CACHE] Artifact cache entry ignored due to empty/invalid payload for ${url}`);
            return null;
        }

        this.touchArtifactEntry(entry).catch((error) => {
            log.debug(`[CACHE] Failed to touch artifact cache entry: ${error}`);
        });

        log.info(`[CACHE] Artifact cache hit for ${url} (cached at ${entry.scrapedAt.toISOString()})`);
        return {
            url,
            ...assembled,
            cachedAt: entry.scrapedAt,
            fromCache: true,
        };
    }

    private async touchArtifactEntry(entry: any): Promise<void> {
        const lastAccessedAt = entry.lastAccessedAt instanceof Date ? entry.lastAccessedAt : null;
        if (lastAccessedAt && Date.now() - lastAccessedAt.getTime() < 60 * 60 * 1000) {
            return;
        }
        const db = await getDB();
        await db
            .update(schemas.pageCacheEntries)
            .set({ lastAccessedAt: new Date() })
            .where(eq(schemas.pageCacheEntries.uuid, entry.uuid));
    }

    private async getFromLegacyCache(
        url: string,
        options: CacheKeyParams,
        effectiveMaxAge: number
    ): Promise<CachedResult | null> {
        const artifactConfig = getArtifactCacheConfig();
        const cacheConfig = getCacheConfig();
        if (!artifactConfig.legacyFallbackEnabled || !cacheConfig.pageCacheEnabled || process.env.ANYCRAWL_STORAGE !== "s3") {
            return null;
        }

        const { urlHash, optionsHash } = computeCacheKey({ ...options, url });
        const minScrapedAt = new Date(Date.now() - effectiveMaxAge);
        log.info(`[CACHE] Legacy cache check: urlHash=${urlHash.substring(0, 16)}..., optionsHash=${optionsHash.substring(0, 16)}..., minScrapedAt=${minScrapedAt.toISOString()}`);

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

        const content = await getContentFromS3(cached.s3Key);
        if (!content) {
            log.warning(`[CACHE] S3 content not found for key: ${cached.s3Key}`);
            return null;
        }
        if (!shouldCache({}, content)) {
            log.warning(`[CACHE] Legacy cache entry ignored due to empty/invalid payload for ${url}`);
            return null;
        }

        this.saveArtifactsToCache(url, options, content, {
            statusCode: cached.statusCode ?? 200,
            contentType: cached.contentType ?? undefined,
            contentLength: cached.contentLength ?? undefined,
            scrapedAt: cached.scrapedAt,
        }).catch((error) => {
            log.warning(`[CACHE] Failed to backfill artifact cache for ${url}: ${error}`);
        });

        log.info(`[CACHE] Legacy cache hit for ${url} (cached at ${cached.scrapedAt.toISOString()})`);
        return {
            ...content,
            cachedAt: cached.scrapedAt,
            fromCache: true,
        };
    }

    private async saveArtifactsToCache(
        url: string,
        options: CacheKeyParams,
        result: CachedContent,
        pageMetadata?: {
            statusCode?: number;
            contentType?: string;
            contentLength?: number;
            scrapedAt?: Date;
        }
    ): Promise<void> {
        const artifactConfig = getArtifactCacheConfig();
        if (!artifactConfig.artifactsEnabled) {
            return;
        }

        const { urlHash, snapshotHash } = computeSnapshotKey({ ...options, url });
        const normalizedUrl = normalizeUrl(url);
        const domain = new URL(url).hostname.toLowerCase();
        const now = new Date();
        const scrapedAt = pageMetadata?.scrapedAt ?? now;
        const title = typeof (result as any).title === "string" ? String((result as any).title).trim() : null;
        const description = extractDescription(result);
        const hasScreenshot = !!((result as any).screenshot || (result as any)["screenshot@fullPage"]);
        const db = await getDB();

        const entryUuid = randomUUID();
        await db
            .insert(schemas.pageCacheEntries)
            .values({
                uuid: entryUuid,
                url,
                urlHash,
                normalizedUrl,
                snapshotHash,
                domain,
                engine: options.engine,
                proxyMode: normalizeProxyForCache(options.proxy),
                statusCode: pageMetadata?.statusCode ?? 200,
                contentType: pageMetadata?.contentType ?? null,
                contentLength: pageMetadata?.contentLength ?? null,
                title,
                description,
                hasScreenshot,
                scrapedAt,
                updatedAt: now,
            })
            .onConflictDoUpdate({
                target: [schemas.pageCacheEntries.snapshotHash],
                set: {
                    url,
                    urlHash,
                    normalizedUrl,
                    domain,
                    engine: options.engine,
                    proxyMode: normalizeProxyForCache(options.proxy),
                    statusCode: pageMetadata?.statusCode ?? 200,
                    contentType: pageMetadata?.contentType ?? null,
                    contentLength: pageMetadata?.contentLength ?? null,
                    title,
                    description,
                    hasScreenshot,
                    scrapedAt,
                    updatedAt: now,
                },
            });

        const [entry] = await db
            .select()
            .from(schemas.pageCacheEntries)
            .where(eq(schemas.pageCacheEntries.snapshotHash, snapshotHash))
            .limit(1);
        if (!entry) {
            throw new Error("Failed to read page cache entry after upsert");
        }

        const artifacts = await this.buildArtifactsForStorage(url, options, result, artifactConfig.dbArtifactMaxBytes, urlHash);
        for (const artifact of artifacts) {
            const values = {
                uuid: randomUUID(),
                entryUuid: entry.uuid,
                artifactType: artifact.type,
                artifactOptionsHash: artifact.optionsHash,
                storageMode: artifact.storageMode,
                contentText: typeof artifact.value === "string" && artifact.storageMode === "db" ? artifact.value : null,
                contentJson: typeof artifact.value === "string" || artifact.storageMode !== "db" ? null : artifact.value,
                s3Key: artifact.s3Key ?? null,
                contentHash: artifact.contentHash,
                contentBytes: artifact.contentBytes,
                scrapedAt,
                updatedAt: now,
            };
            await db
                .insert(schemas.pageCacheArtifacts)
                .values(values)
                .onConflictDoUpdate({
                    target: [
                        schemas.pageCacheArtifacts.entryUuid,
                        schemas.pageCacheArtifacts.artifactType,
                        schemas.pageCacheArtifacts.artifactOptionsHash,
                    ],
                    set: {
                        storageMode: values.storageMode,
                        contentText: values.contentText,
                        contentJson: values.contentJson,
                        s3Key: values.s3Key,
                        contentHash: values.contentHash,
                        contentBytes: values.contentBytes,
                        scrapedAt: values.scrapedAt,
                        updatedAt: now,
                    },
                });
        }
    }

    private async buildArtifactsForStorage(
        url: string,
        options: CacheKeyParams,
        result: CachedContent,
        maxDbBytes: number,
        urlHash: string
    ): Promise<PageCacheArtifactValue[]> {
        const artifacts: PageCacheArtifactValue[] = [];
        const artifactTypes = this.getArtifactTypesForWrite(result);
        for (const type of artifactTypes) {
            const value = this.getArtifactValue(type, result);
            if (value === undefined || value === null) {
                continue;
            }
            const contentBytes = jsonByteLength(value);
            const contentHash = hashArtifactValue(value);
            const optionsHash = computeArtifactOptionsHash({ ...options, url, artifactType: type, modelId: getArtifactModelId(type) });
            const shouldStoreInDb = this.shouldStoreArtifactInDb(type, value, maxDbBytes);
            if (shouldStoreInDb) {
                artifacts.push({
                    type,
                    value,
                    optionsHash,
                    storageMode: "db",
                    contentBytes,
                    contentHash,
                });
                continue;
            }
            if (process.env.ANYCRAWL_STORAGE !== "s3") {
                log.debug(`[CACHE] Skipping artifact ${type} for ${url}: S3 unavailable and artifact too large/source-like`);
                continue;
            }
            const s3Key = await saveContentToS3(`${urlHash}/${type}`, { url, artifactType: type, value });
            artifacts.push({
                type,
                value,
                optionsHash,
                storageMode: "s3",
                contentBytes,
                contentHash,
                s3Key,
            });
        }
        return artifacts;
    }

    /**
     * Get cached result from database and S3
     */
    async getFromCache(
        url: string,
        options: CacheKeyParams,
        maxAge?: number
    ): Promise<CachedResult | null> {
        log.info(`[CACHE] getFromCache ENTER: url=${url.substring(0, 50)}...`);
        const config = getCacheConfig();
        log.info(`[CACHE] getFromCache config check: storage=${process.env.ANYCRAWL_STORAGE}, cacheEnabled=${process.env.ANYCRAWL_CACHE_ENABLED}, pageCacheEnabled=${config.pageCacheEnabled}`);
        if (!config.pageCacheEnabled) {
            log.warning(`[CACHE] getFromCache skipped: pageCacheEnabled=${config.pageCacheEnabled}`);
            return null;
        }

        const effectiveMaxAge = maxAge ?? config.defaultMaxAge;

        // max_age = 0 means force refresh, skip cache
        if (effectiveMaxAge === 0) {
            log.debug(`[CACHE] getFromCache skipped: effectiveMaxAge=0`);
            return null;
        }

        try {
            try {
                const artifactHit = await this.getFromArtifactCache(url, options, effectiveMaxAge);
                if (artifactHit) return artifactHit;
            } catch (artifactError) {
                log.warning(`[CACHE] Artifact cache read failed for ${url}; falling back to legacy cache: ${artifactError}`);
            }

            const legacyHit = await this.getFromLegacyCache(url, options, effectiveMaxAge);
            if (legacyHit) return legacyHit;

            log.info(`[CACHE] Cache miss for ${url}`);
            return null;
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
        log.info(`[CACHE] saveToCache config check: storage=${process.env.ANYCRAWL_STORAGE}, cacheEnabled=${process.env.ANYCRAWL_CACHE_ENABLED}, pageCacheEnabled=${config.pageCacheEnabled}`);
        if (!config.pageCacheEnabled) {
            log.warning(`[CACHE] saveToCache skipped: pageCacheEnabled=${config.pageCacheEnabled}`);
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
            log.info(`[CACHE] computeCacheKey: url=${url.substring(0, 50)}..., urlHash=${urlHash.substring(0, 16)}..., optionsHash=${optionsHash.substring(0, 16)}..., proxy=${options.proxy}, engine=${options.engine}`);
            const domain = new URL(url).hostname.toLowerCase();
            const now = new Date();

            const artifactConfig = getArtifactCacheConfig();
            let artifactSaved = false;
            if (artifactConfig.artifactsEnabled) {
                try {
                    await this.saveArtifactsToCache(url, options, result, pageMetadata);
                    artifactSaved = true;
                } catch (artifactError) {
                    log.warning(`[CACHE] Artifact cache write failed for ${url}; legacy cache fallback may be used: ${artifactError}`);
                }
            }

            if (process.env.ANYCRAWL_STORAGE !== "s3") {
                log.info(`[CACHE] Saved artifact cache for ${url}`);
                return;
            }

            const shouldWriteLegacy = artifactConfig.legacyWriteEnabled || !artifactConfig.artifactsEnabled || !artifactSaved;
            if (!shouldWriteLegacy) {
                log.info(`[CACHE] Saved artifact cache for ${url}`);
                return;
            }

            const s3Key = await saveContentToS3(urlHash, result);

            const title = typeof (result as any).title === "string" ? String((result as any).title).trim() : null;
            const description = extractDescription(result);

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

            log.info(`[CACHE] Saved artifact and legacy cache for ${url}`);
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
            const artifactConfig = getArtifactCacheConfig();
            if (artifactConfig.artifactsEnabled) {
                try {
                    const results = await db
                        .select({
                            url: schemas.pageCacheEntries.url,
                            title: schemas.pageCacheEntries.title,
                            description: schemas.pageCacheEntries.description,
                        })
                        .from(schemas.pageCacheEntries)
                        .where(eq(schemas.pageCacheEntries.domain, domain))
                        .orderBy(desc(schemas.pageCacheEntries.scrapedAt))
                        .limit(limit);

                    if (results.length > 0) {
                        return results.map((r: { url: string; title: string | null; description: string | null }) => ({
                            url: r.url,
                            title: r.title ?? undefined,
                            description: r.description ?? undefined,
                        }));
                    }
                } catch (artifactIndexError) {
                    log.debug(`[CACHE] Artifact page cache index unavailable, falling back to legacy page_cache: ${artifactIndexError}`);
                }
            }

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
