import { Sitemap, RobotsTxtFile, gotScraping, extractUrlsFromCheerio } from "crawlee";
import * as cheerio from "cheerio";
import { log } from "@anycrawl/libs";
import proxyConfiguration from "../managers/Proxy.js";
import { CacheManager } from "../managers/Cache.js";

/**
 * Map link item with optional title and description
 */
export interface MapLink {
    url: string;
    title?: string;
    description?: string;
}

/**
 * Options for map operation
 */
export interface MapOptions {
    limit?: number;
    includeSubdomains?: boolean;
    ignoreSitemap?: boolean;
    searchService?: any;
    maxAge?: number;
    useIndex?: boolean;
}

/**
 * Result of map operation
 */
export interface MapResult {
    links: MapLink[];
    fromCache?: boolean;
}

/**
 * MapService - Extracts URLs from a website using multiple sources:
 * 1. Sitemap parsing (using Crawlee's RobotsTxtFile and Sitemap utilities)
 * 2. Search engine results (if search query provided)
 * 3. Page link extraction (HTML <a href> tags)
 */
export class MapService {
    /**
     * Main entry point - combines all three sources
     */
    async map(url: string, options: MapOptions = {}): Promise<MapResult> {
        const cacheManager = CacheManager.getInstance();
        const baseUrl = new URL(url);

        // Check cache first (if max_age > 0 or undefined)
        if (options.maxAge !== 0) {
            const cached = await cacheManager.getMapFromCache(url, 'combined', options.maxAge);
            if (cached) {
                let links = cached.urls;
                // Apply domain filter and limit
                links = this.filterByDomain(links, baseUrl, options.includeSubdomains ?? false);
                links = links.slice(0, options.limit ?? 5000);
                return { links, fromCache: true };
            }
        }

        const urlMap: Map<string, MapLink> = new Map();

        // Track source statistics
        let sitemapCount = 0;
        let searchCount = 0;
        let pageLinksCount = 0;

        // Use global proxyConfiguration for all requests
        const resolvedProxyUrl = await proxyConfiguration.newUrl() ?? undefined;
        if (resolvedProxyUrl) {
            log.info(`[MapService] Using proxy: ${resolvedProxyUrl}`);
        }

        // 1. Sitemap URLs (if not ignored)
        if (!options.ignoreSitemap) {
            try {
                const sitemapUrls = await this.getSitemapUrls(url, resolvedProxyUrl);
                sitemapCount = sitemapUrls.length;
                sitemapUrls.forEach(u => {
                    if (!urlMap.has(u)) {
                        urlMap.set(u, { url: u });
                    }
                });
                log.info(`[MapService] Found ${sitemapCount} URLs from sitemap`);
            } catch (error) {
                log.warning(`[MapService] Failed to get sitemap URLs: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else {
            log.info(`[MapService] Sitemap parsing skipped (ignore_sitemap=true)`);
        }

        // 2. Search engine URLs (automatically search for indexed pages using site:domain)
        if (options.searchService) {
            try {
                const searchResults = await this.getSearchEngineUrls(url, options.searchService, options.limit);
                searchCount = searchResults.length;
                searchResults.forEach(r => {
                    const existing = urlMap.get(r.url);
                    if (existing) {
                        existing.title = existing.title || r.title;
                        existing.description = existing.description || r.description;
                    } else {
                        urlMap.set(r.url, r);
                    }
                });
                log.info(`[MapService] Found ${searchCount} URLs from search engine`);
            } catch (error) {
                log.warning(`[MapService] Failed to get search engine URLs: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else {
            log.info(`[MapService] Search engine discovery skipped (no searchService provided)`);
        }

        // 3. Page link extraction
        try {
            const pageLinks = await this.getPageLinks(url, resolvedProxyUrl);
            pageLinksCount = pageLinks.length;
            pageLinks.forEach(link => {
                const existing = urlMap.get(link.url);
                if (existing) {
                    existing.title = existing.title || link.title;
                    existing.description = existing.description || link.description;
                } else {
                    urlMap.set(link.url, link);
                }
            });
            log.info(`[MapService] Found ${pageLinksCount} URLs from page links`);
        } catch (error) {
            log.warning(`[MapService] Failed to get page links: ${error instanceof Error ? error.message : String(error)}`);
        }

        // 4. Page cache index (if enabled)
        let indexCount = 0;
        if (options.useIndex !== false) {
            try {
                const indexUrls = await cacheManager.getUrlsFromPageCacheIndex(url, options.limit);
                indexCount = indexUrls.length;
                indexUrls.forEach(link => {
                    const existing = urlMap.get(link.url);
                    if (existing) {
                        existing.title = existing.title || link.title;
                        existing.description = existing.description || link.description;
                    } else {
                        urlMap.set(link.url, link);
                    }
                });
                log.info(`[MapService] Found ${indexCount} URLs from page cache index`);
            } catch (error) {
                log.warning(`[MapService] Failed to get URLs from page cache index: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        // Filter, sort, limit
        let links = Array.from(urlMap.values());
        const totalBeforeFilter = links.length;
        links = this.filterByDomain(links, baseUrl, options.includeSubdomains ?? false);

        links = links.slice(0, options.limit ?? 5000);

        // Log summary with source breakdown
        log.info(`[MapService] Summary: sitemap=${sitemapCount}, search=${searchCount}, pageLinks=${pageLinksCount}, index=${indexCount}, total=${totalBeforeFilter}, afterFilter=${links.length}`);

        // Save to cache (save unfiltered results for reuse)
        if (links.length > 0) {
            await cacheManager.saveMapToCache(url, 'combined', Array.from(urlMap.values()));
        }

        return { links };
    }

    /**
     * Source 1: Get URLs from sitemap using Crawlee's RobotsTxtFile and Sitemap utilities
     * - First try to get sitemap URLs from robots.txt using RobotsTxtFile.find()
     * - If robots.txt has sitemaps, use RobotsTxtFile.parseUrlsFromSitemaps()
     * - Otherwise fallback to Sitemap.tryCommonNames()
     */
    private async getSitemapUrls(baseUrl: string, proxyUrl?: string): Promise<string[]> {
        try {
            // Try to find and parse robots.txt using Crawlee's RobotsTxtFile
            const robotsTxt = await RobotsTxtFile.find(baseUrl, proxyUrl);

            // Get sitemap URLs from robots.txt
            const sitemapUrls = robotsTxt.getSitemaps();

            if (sitemapUrls.length > 0) {
                log.debug(`[MapService] Found ${sitemapUrls.length} sitemaps in robots.txt`);
                // Parse all URLs from the sitemaps referenced in robots.txt
                const urls = await robotsTxt.parseUrlsFromSitemaps();
                if (urls.length > 0) {
                    return urls;
                }
            }
        } catch (error) {
            log.debug(`[MapService] RobotsTxtFile.find failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Fallback: Try common sitemap locations using Crawlee's Sitemap.tryCommonNames()
        try {
            log.debug(`[MapService] Trying common sitemap locations for ${baseUrl}`);
            const sitemap = await Sitemap.tryCommonNames(baseUrl, proxyUrl);
            return sitemap.urls;
        } catch (error) {
            log.debug(`[MapService] Sitemap.tryCommonNames failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /**
     * Source 2: Get URLs from search engine
     * Automatically uses site: operator to find indexed pages for the domain
     * Uses the URL limit to calculate pages needed, then fetches concurrently
     * Max 20 pages (200 results) to avoid excessive requests
     */
    private async getSearchEngineUrls(
        baseUrl: string,
        searchService: any,
        urlLimit: number = 5000
    ): Promise<MapLink[]> {
        const hostname = new URL(baseUrl).hostname;
        const query = `site:${hostname}`;

        try {
            // Calculate search limit based on URL limit
            // Each page returns ~10 results, max 20 pages (200 results)
            const searchLimit = Math.min(urlLimit, 200);

            const results = await searchService.search('google', {
                query,
                limit: searchLimit,
                concurrent: true,
            });

            return results
                .filter((r: any) => r.url)
                .map((r: any) => ({
                    url: r.url,
                    title: r.title,
                    description: r.description || r.snippet,
                }));
        } catch (error) {
            log.warning(`[MapService] Search engine query failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /**
     * Source 3: Extract links from HTML page
     * Uses Crawlee's extractUrlsFromCheerio for URL extraction
     */
    private async getPageLinks(url: string, proxyUrl?: string): Promise<MapLink[]> {
        try {
            const response = await gotScraping({
                url,
                timeout: { request: 30000 },
                retry: { limit: 2 },
                proxyUrl,
            });

            if (response.statusCode !== 200) {
                return [];
            }

            const $ = cheerio.load(response.body);
            const baseUrl = new URL(url);

            // Use Crawlee's extractUrlsFromCheerio for URL extraction
            // Type assertion needed due to cheerio version mismatch between project and Crawlee
            const extractedUrls = extractUrlsFromCheerio($ as any, 'a[href]', baseUrl.origin);

            const links: MapLink[] = [];
            const seen = new Set<string>();

            for (const extractedUrl of extractedUrls) {
                // Skip non-http(s) URLs and duplicates
                if (!extractedUrl.startsWith('http')) continue;
                const urlWithoutFragment = extractedUrl.split('#')[0] || extractedUrl;
                if (seen.has(urlWithoutFragment)) continue;
                seen.add(urlWithoutFragment);

                // Find the corresponding <a> element to extract title/description
                const element = $(`a[href="${extractedUrl}"], a[href="${extractedUrl.replace(baseUrl.origin, '')}"]`).first();
                const titleAttr = element.attr('title');
                const titleText = element.text().trim();
                const title = titleAttr || titleText || undefined;
                const description = element.attr('aria-label') || undefined;

                links.push({
                    url: urlWithoutFragment,
                    title: title ? title.substring(0, 200) : undefined,
                    description: description ? description.substring(0, 500) : undefined,
                });
            }

            return links;
        } catch (error) {
            log.warning(`[MapService] Failed to extract page links: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /**
     * Filter URLs by domain
     * - If includeSubdomains is false, only include URLs from the exact domain
     * - If includeSubdomains is true, include URLs from subdomains as well
     */
    private filterByDomain(links: MapLink[], baseUrl: URL, includeSubdomains: boolean): MapLink[] {
        const baseDomain = this.getBaseDomain(baseUrl.hostname);

        return links.filter(link => {
            try {
                const linkUrl = new URL(link.url);
                const linkDomain = this.getBaseDomain(linkUrl.hostname);

                if (includeSubdomains) {
                    // Include if base domain matches
                    return linkDomain === baseDomain;
                } else {
                    // Include only if exact hostname matches
                    return linkUrl.hostname === baseUrl.hostname;
                }
            } catch {
                return false;
            }
        });
    }

    /**
     * Get base domain from hostname (e.g., "www.example.com" -> "example.com")
     */
    private getBaseDomain(hostname: string): string {
        const parts = hostname.split('.');
        if (parts.length <= 2) return hostname;
        return parts.slice(-2).join('.');
    }

}
