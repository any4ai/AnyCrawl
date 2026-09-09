import { Request, ProxyConfiguration as CrawleeProxyConfiguration } from "crawlee";
import { log, config, isProxyMode, getResolvedProxyMode, getBaseProxyUrls, getStealthProxyUrls } from "@anycrawl/libs";
import type { ProxyMode, ResolvedProxyMode } from "@anycrawl/libs";
import type { Dictionary } from '@crawlee/types';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as http from 'http';
import * as https from 'https';

import { cryptoRandomObjectId } from '@apify/utilities';
import { ProxyCacheManager } from './ProxyCacheManager.js';
import { materializeHttpProxy, proxyConfigurationId, stickyLeasePreference, stickyProxySelection, STICKY_SESSION_TOKEN, StickyProxyConfigurationError, validateStickyProxyTemplate } from '../core/StickyProxyContext.js';

export type { ProxyMode, ResolvedProxyMode };
export { isProxyMode, getResolvedProxyMode as getResolvedProxyModeName };

export interface ProxyConfigurationFunction {
    (sessionId: string | number, options?: { request?: Request; proxyTier?: number }): string | null | Promise<string | null>;
}

export interface ProxyConfigurationOptions {
    /**
     * An array of custom proxy URLs to be rotated.
     * Custom proxies are not compatible with Apify Proxy and an attempt to use both
     * configuration options will cause an error to be thrown on initialize.
     */
    proxyUrls?: string[];

    /**
     * Custom function that allows you to generate the new proxy URL dynamically. It gets the `sessionId` as a parameter and an optional parameter with the `Request` object when applicable.
     * Can return either stringified proxy URL or `null` if the proxy should not be used. Can be asynchronous.
     *
     * This function is used to generate the URL when {@apilink ProxyConfiguration.newUrl} or {@apilink ProxyConfiguration.newProxyInfo} is called.
     */
    newUrlFunction?: ProxyConfigurationFunction;

    /**
     * An array of custom proxy URLs to be rotated stratified in tiers.
     * This is a more advanced version of `proxyUrls` that allows you to define a hierarchy of proxy URLs
     * If everything goes well, all the requests will be sent through the first proxy URL in the list.
     * Whenever the crawler encounters a problem with the current proxy on the given domain, it will switch to the higher tier for this domain.
     * The crawler probes lower-level proxies at intervals to check if it can make the tier downshift.
     *
     * This feature is useful when you have a set of proxies with different performance characteristics (speed, price, antibot performance etc.) and you want to use the best one for each domain.
     *
     * Use `null` as a proxy URL to disable the proxy for the given tier.
     */
    tieredProxyUrls?: (string | null)[][];
}

export interface TieredProxy {
    proxyUrl: string | null;
    proxyTier?: number;
}

/**
 * The main purpose of the ProxyInfo object is to provide information
 * about the current proxy connection used by the crawler for the request.
 * Outside of crawlers, you can get this object by calling {@apilink ProxyConfiguration.newProxyInfo}.
 *
 * **Example usage:**
 *
 * ```javascript
 * const proxyConfiguration = new ProxyConfiguration({
 *   proxyUrls: ['...', '...'] // List of Proxy URLs to rotate
 * });
 *
 * // Getting proxyInfo object by calling class method directly
 * const proxyInfo = await proxyConfiguration.newProxyInfo();
 *
 * // In crawler
 * const crawler = new CheerioCrawler({
 *   // ...
 *   proxyConfiguration,
 *   requestHandler({ proxyInfo }) {
 *      // Getting used proxy URL
 *       const proxyUrl = proxyInfo.url;
 *
 *      // Getting ID of used Session
 *       const sessionIdentifier = proxyInfo.sessionId;
 *   }
 * })
 *
 * ```
 */
export interface ProxyInfo {
    /** Stable identity for caching a materialized HTTP proxy configuration. */
    stickyProxyTemplate?: string;
    /**
     * The identifier of used {@apilink Session}, if used.
     */
    sessionId?: string;

    /**
     * The URL of the proxy.
     */
    url: string;

    /**
     * Username for the proxy.
     */
    username?: string;

    /**
     * User's password for the proxy.
     */
    password: string;

    /**
     * Hostname of your proxy.
     */
    hostname: string;

    /**
     * Proxy port.
     */
    port: number | string;

    /**
     * Proxy tier for the current proxy, if applicable (only for `tieredProxyUrls`).
     */
    proxyTier?: number;
}

interface TieredProxyOptions {
    request?: Request;
    proxyTier?: number;
}

/**
 * Configures connection to a proxy server with the provided options. Proxy servers are used to prevent target websites from blocking
 * your crawlers based on IP address rate limits or blacklists. Setting proxy configuration in your crawlers automatically configures
 * them to use the selected proxies for all connections. You can get information about the currently used proxy by inspecting
 * the {@apilink ProxyInfo} property in your crawler's page function. There, you can inspect the proxy's URL and other attributes.
 *
 * If you want to use your own proxies, use the {@apilink ProxyConfigurationOptions.proxyUrls} option. Your list of proxy URLs will
 * be rotated by the configuration if this option is provided.
 *
 * **Example usage:**
 *
 * ```javascript
 *
 * const proxyConfiguration = new ProxyConfiguration({
 *   proxyUrls: ['...', '...'],
 * });
 *
 * const crawler = new CheerioCrawler({
 *   // ...
 *   proxyConfiguration,
 *   requestHandler({ proxyInfo }) {
 *      const usedProxyUrl = proxyInfo.url; // Getting the proxy URL
 *   }
 * })
 *
 * ```
 * @category Scaling
 */
export class ProxyConfiguration extends CrawleeProxyConfiguration {

    /**
     * Creates a {@apilink ProxyConfiguration} instance based on the provided options. Proxy servers are used to prevent target websites from
     * blocking your crawlers based on IP address rate limits or blacklists. Setting proxy configuration in your crawlers automatically configures
     * them to use the selected proxies for all connections.
     *
     * ```javascript
     * const proxyConfiguration = new ProxyConfiguration({
     *     proxyUrls: ['http://user:pass@proxy-1.com', 'http://user:pass@proxy-2.com'],
     * });
     *
     * const crawler = new CheerioCrawler({
     *   // ...
     *   proxyConfiguration,
     *   requestHandler({ proxyInfo }) {
     *       const usedProxyUrl = proxyInfo.url; // Getting the proxy URL
     *   }
     * })
     *
     * ```
     */
    constructor(options: ProxyConfigurationOptions = {}) {
        const parentOptions = { ...options };

        // If multiple configuration options exist simultaneously, temporarily remove them to bypass parent class validation
        const hasMultipleOptions = [options.proxyUrls, options.newUrlFunction, options.tieredProxyUrls].filter(x => x).length > 1;

        if (hasMultipleOptions) {
            // Only keep newUrlFunction, remove other options to pass parent class validation
            delete parentOptions.proxyUrls;
            delete parentOptions.tieredProxyUrls;
        }

        super(parentOptions);
        const { validateRequired, ...rest } = options as Dictionary;

        // Basic validation
        if (options.proxyUrls && (!Array.isArray(options.proxyUrls) || options.proxyUrls.length === 0)) {
            throw new Error('proxyUrls must be a non-empty array');
        }
        if (options.newUrlFunction && typeof options.newUrlFunction !== 'function') {
            throw new Error('newUrlFunction must be a function');
        }
        if (options.tieredProxyUrls && (!Array.isArray(options.tieredProxyUrls) || options.tieredProxyUrls.length === 0)) {
            throw new Error('tieredProxyUrls must be a non-empty array');
        }

        const { proxyUrls, newUrlFunction, tieredProxyUrls } = options;

        if ([proxyUrls, newUrlFunction].filter((x) => x).length > 1)
            this._throwCannotCombineCustomMethods();
        if ([proxyUrls, tieredProxyUrls].filter((x) => x).length > 1)
            this._throwCannotCombineCustomMethods();
        if (!proxyUrls && !newUrlFunction && validateRequired) this._throwNoOptionsProvided();

        this.proxyUrls = proxyUrls;
        this.newUrlFunction = newUrlFunction;
        this.tieredProxyUrls = tieredProxyUrls;
    }

    /**
     * This function creates a new {@apilink ProxyInfo} info object.
     * It is used by CheerioCrawler and PuppeteerCrawler to generate proxy URLs and also to allow the user to inspect
     * the currently used proxy via the requestHandler parameter `proxyInfo`.
     * Use it if you want to work with a rich representation of a proxy URL.
     * If you need the URL string only, use {@apilink ProxyConfiguration.newUrl}.
     * @param [sessionId]
     *  Represents the identifier of user {@apilink Session} that can be managed by the {@apilink SessionPool} or
     *  you can use the Apify Proxy [Session](https://docs.apify.com/proxy#sessions) identifier.
     *  When the provided sessionId is a number, it's converted to a string. Property sessionId of
     *  {@apilink ProxyInfo} is always returned as a type string.
     *
     *  All the HTTP requests going through the proxy with the same session identifier
     *  will use the same target proxy server (i.e. the same IP address).
     *  The identifier must not be longer than 50 characters and include only the following: `0-9`, `a-z`, `A-Z`, `"."`, `"_"` and `"~"`.
     * @return Represents information about used proxy and its configuration.
     */
    async newProxyInfo(sessionId?: string | number, options?: TieredProxyOptions): Promise<ProxyInfo | undefined> {
        if (stickyProxySelection.getStore()) await ensureProxyConfigFresh();
        if (typeof sessionId === 'number') sessionId = `${sessionId}`;

        let url: string | undefined | null;
        let tier: number | undefined;

        // First try newUrlFunction
        if (this.newUrlFunction) {
            const result = await this._callNewUrlFunction(sessionId, {
                request: options?.request,
                proxyTier: options?.proxyTier,
            } as any);
            if (result) {
                url = result;
            }
        }
        // If newUrlFunction returns null or is not set, try tieredProxyUrls
        if (!url && this.tieredProxyUrls) {
            const { proxyUrl, proxyTier } = this._handleTieredUrl(sessionId ?? cryptoRandomObjectId(6), options);
            url = proxyUrl ?? undefined;
            tier = proxyTier;
        }

        // If both fail, try custom URLs as fallback
        if (!url && this.proxyUrls && this.proxyUrls.length > 0) {
            url = this._handleCustomUrl(sessionId);
        }

        if (!url) return undefined;

        let stickyProxyTemplate: string | undefined;
        if (stickyProxySelection.getStore()) validateStickyProxyTemplate(url, config.proxy.stickyTtlSecs!);
        else {
            if (url.includes(STICKY_SESSION_TOKEN)) stickyProxyTemplate = url;
            url = materializeHttpProxy(url);
        }

        const { username, password, port, hostname } = new URL(url);

        return {
            ...(stickyProxyTemplate ? { stickyProxyTemplate } : {}),
            sessionId,
            url,
            username: decodeURIComponent(username),
            password: decodeURIComponent(password),
            hostname,
            port: port!,
            proxyTier: tier,
        };
    }

    /**
     * Given a session identifier and a request / proxy tier, this function returns a new proxy URL based on the provided configuration options.
     * @param _sessionId Session identifier
     * @param options Options for the tiered proxy rotation
     * @returns An object with the proxy URL and the proxy tier used.
     */
    protected _handleTieredUrl(_sessionId: string, options?: TieredProxyOptions): TieredProxy {
        if (!this.tieredProxyUrls) throw new Error('Tiered proxy URLs are not set');

        // If the request URL matches a configured proxy rule, merge the matched proxy
        // with the default ANYCRAWL_PROXY_URL list for rotation/fallback.
        if (options?.request?.url) {
            const matchedProxy = findProxyForUrl(options.request.url);
            if (matchedProxy) {
                const fallbackProxies = (this.tieredProxyUrls?.flat().filter((u): u is string => !!u) ?? []);
                const combined = [matchedProxy, ...fallbackProxies];
                const selectedProxy = combined[this.nextCustomUrlIndex++ % combined.length] ?? null;
                if (selectedProxy) {
                    const originalUrl = (options.request.userData as any)?.original_url;
                    this.log.info(`[PROXY] URL: ${options.request.url}${originalUrl && originalUrl !== options.request.url ? ` (original: ${originalUrl})` : ''} → Using merged proxy (rule + fallback): ${proxyConfigurationId(selectedProxy)}`);
                }
                return {
                    proxyUrl: selectedProxy,
                };
            }
        }

        if (!options || (!options?.request && options?.proxyTier === undefined)) {
            const allProxyUrls = this.tieredProxyUrls.flat().filter((url): url is string | null => url !== undefined);
            const selectedProxy = allProxyUrls[this.nextCustomUrlIndex++ % allProxyUrls.length] ?? null;
            if (selectedProxy) {
                this.log.info(`[PROXY] → Using tiered proxy (fallback): ${proxyConfigurationId(selectedProxy)}`);
            }
            return {
                proxyUrl: selectedProxy,
            };
        }

        let tierPrediction = options.proxyTier!;

        if (typeof tierPrediction !== 'number') {
            tierPrediction = this.predictProxyTier(options.request!)!;
        }

        const proxyTier = this.tieredProxyUrls![tierPrediction];
        if (!proxyTier) {
            throw new Error(`Invalid proxy tier: ${tierPrediction}`);
        }

        const selectedProxy = proxyTier[this.nextCustomUrlIndex++ % proxyTier.length] ?? null;
        if (selectedProxy) {
            const requestUrl = options?.request?.url || 'unknown';
            const originalUrl = options?.request?.userData ? (options.request.userData as any)?.original_url : undefined;
            this.log.info(`[PROXY] URL: ${requestUrl}${originalUrl && originalUrl !== requestUrl ? ` (original: ${originalUrl})` : ''} → Using tiered proxy from tier ${tierPrediction}: ${proxyConfigurationId(selectedProxy)}`);
        }

        return {
            proxyUrl: selectedProxy,
            proxyTier: tierPrediction,
        };
    }

    /**
     * Returns a new proxy URL based on provided configuration options and the `sessionId` parameter.
     * @param [sessionId]
     *  Represents the identifier of user {@apilink Session} that can be managed by the {@apilink SessionPool} or
     *  you can use the Apify Proxy [Session](https://docs.apify.com/proxy#sessions) identifier.
     *  When the provided sessionId is a number, it's converted to a string.
     *
     *  All the HTTP requests going through the proxy with the same session identifier
     *  will use the same target proxy server (i.e. the same IP address).
     *  The identifier must not be longer than 50 characters and include only the following: `0-9`, `a-z`, `A-Z`, `"."`, `"_"` and `"~"`.
     * @return A string with a proxy URL, including authentication credentials and port number.
     *  For example, `http://bob:password123@proxy.example.com:8000`
     */
    async newUrl(sessionId?: string | number, options?: TieredProxyOptions): Promise<string | undefined> {
        if (typeof sessionId === 'number') sessionId = `${sessionId}`;

        await ensureProxyConfigFresh();

        // First try newUrlFunction
        if (this.newUrlFunction) {
            const result = await this._callNewUrlFunction(sessionId, { request: options?.request, proxyTier: options?.proxyTier } as any);
            if (result) {
                return materializeHttpProxy(result);
            }
        }

        // If newUrlFunction returns null, try tieredProxyUrls
        if (this.tieredProxyUrls) {
            const url = this._handleTieredUrl(sessionId ?? cryptoRandomObjectId(6), options).proxyUrl;
            return url ? materializeHttpProxy(url) : undefined;
        }

        // If both fail, try custom URLs as fallback
        if (this.proxyUrls && this.proxyUrls.length > 0) {
            const url = this._handleCustomUrl(sessionId);
            return url ? materializeHttpProxy(url) : undefined;
        }

        // If all methods fail, return null
        return undefined;
    }
}
interface ProxyRule {
    domain?: string;   // Domain pattern using wildcards, e.g., "*.example.com"
    url?: string;      // Exact URL match
    pattern?: string;  // Full URL pattern using wildcards, e.g., "https://*.github.com/*"
    proxy: string;     // Proxy URL to use
}

interface ProxyConfig {
    rules: ProxyRule[];
}

function validateStickyRules(value: ProxyConfig): void {
    if (!config.proxy.stickyEnabled) return;
    if (!Array.isArray(value.rules)) throw new StickyProxyConfigurationError("Sticky proxy rules must be an array");
    for (const rule of value.rules) {
        if (typeof rule.proxy !== "string") throw new StickyProxyConfigurationError("Sticky proxy rule requires a URL template");
        validateStickyProxyTemplate(rule.proxy, config.proxy.stickyTtlSecs!);
    }
}

/**
 * Proxy Configuration for URL-based routing
 * ==========================================
 * 
 * Example proxy configuration JSON file:
 * {
 *   "rules": [
 *     {
 *       "url": "https://api.example.com/v1/data",
 *       "proxy": "http://proxy1:8080"
 *     },
 *     {
 *       "domain": "*.gov.au",
 *       "proxy": "http://proxy2:8080"  
 *     },
 *     {
 *       "pattern": "https://*.github.com/api/*",
 *       "proxy": "http://proxy3:8080"
 *     }
 *   ]
 * }
 * 
 * Rule Types (in priority order):
 * --------------------------------
 * 1. url: Exact URL match (highest priority)
 *    - Matches the complete URL exactly
 *    - Example: "https://api.example.com/v1/data"
 * 
 * 2. pattern: Full URL pattern with wildcards
 *    - Matches against the entire URL including protocol and path
 *    - Supports wildcards: * (any characters) and ? (single character)
 *    - Example: "https://*.github.com/api/*"
 * 
 * 3. domain: Domain-only pattern with wildcards (lowest priority)
 *    - Matches against the hostname only
 *    - Useful for routing all requests to a domain through a specific proxy
 *    - Example: "*.gov.au" matches "www.example.gov.au", "test.gov.au", etc.
 * 
 * Wildcard Usage:
 * ---------------
 * - * matches any number of characters
 * - ? matches exactly one character
 * - Patterns are case-insensitive
 * 
 * Configuration:
 * --------------
 * Set ANYCRAWL_PROXY_CONFIG environment variable to your JSON config file path:
 * ANYCRAWL_PROXY_CONFIG=/path/to/proxy-config.json
 * 
 * Or use the provided proxy-config.example.json as a template.
 */

// Proxy config TTL: how long to cache before reloading (default 30 min)
const PROXY_CONFIG_TTL_MS = Math.max(0, Number.parseInt(process.env.ANYCRAWL_PROXY_CONFIG_TTL_MS ?? '1800000', 10) || 1800000);
let proxyConfig: ProxyConfig | null = null;
let proxyConfigFetchedAt = 0;
let proxyConfigSource: string | null = null;
let refreshInProgress: Promise<void> | null = null;

function isHttpSource(s: string): boolean {
    return s.startsWith('http://') || s.startsWith('https://');
}

function loadProxyConfigFromFile(source: string): void {
    try {
        const pathToRead = resolve(source);
        const configContent = readFileSync(pathToRead, 'utf-8');
        const parsed: ProxyConfig = JSON.parse(configContent);
        validateStickyRules(parsed);
        proxyConfig = parsed;
        proxyConfigFetchedAt = Date.now();
        if (proxyConfig?.rules) {
            log.info(`Loaded proxy configuration from ${pathToRead} with ${proxyConfig.rules.length} rules`);
        }
    } catch (error) {
        if (error instanceof StickyProxyConfigurationError) throw error;
        log.error('Failed to load proxy configuration from file', { configPath: source, error });
    }
}

function loadProxyConfigFromHttp(urlStr: string): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
        try {
            const urlObj = new URL(urlStr);
            const lib = urlObj.protocol === 'https:' ? https : http;
            const req = lib.request(urlObj, (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    log.error(`Failed to load proxy configuration from URL: HTTP ${res.statusCode}`, { url: urlStr });
                    res.resume();
                    rejectPromise(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed: ProxyConfig = JSON.parse(data);
                        validateStickyRules(parsed);
                        proxyConfig = parsed;
                        proxyConfigFetchedAt = Date.now();
                        if (proxyConfig?.rules) {
                            log.info(`Loaded proxy configuration from ${urlStr} with ${proxyConfig.rules.length} rules`);
                        }
                        resolvePromise();
                    } catch (e) {
                        log.error('Failed to parse proxy configuration JSON from URL', { url: urlStr, error: e });
                        rejectPromise(e);
                    }
                });
            });
            req.on('error', (e) => {
                log.error('Failed to load proxy configuration from URL', { url: urlStr, error: e });
                rejectPromise(e);
            });
            req.end();
        } catch (error) {
            log.error('Invalid ANYCRAWL_PROXY_CONFIG URL', { url: urlStr, error });
            rejectPromise(error);
        }
    });
}

async function refreshProxyConfig(): Promise<void> {
    if (!proxyConfigSource) return;
    try {
        if (isHttpSource(proxyConfigSource)) {
            await loadProxyConfigFromHttp(proxyConfigSource);
        } else {
            loadProxyConfigFromFile(proxyConfigSource);
        }
    } catch (error) {
        if (error instanceof StickyProxyConfigurationError) throw error;
        // Errors already logged in load functions; keep existing cache
    }
}

// Initial load: file sources loaded immediately; HTTP sources loaded lazily
// on first ensureProxyConfigFresh() to avoid fire-and-forget race conditions.
if (process.env.ANYCRAWL_PROXY_CONFIG) {
    proxyConfigSource = process.env.ANYCRAWL_PROXY_CONFIG.trim();
    if (!isHttpSource(proxyConfigSource)) {
        loadProxyConfigFromFile(proxyConfigSource);
    }
}

/**
 * Ensure proxy config is fresh (within TTL). If expired, reload from source.
 * For file sources the reload is synchronous; for HTTP sources concurrent
 * callers coalesce onto a single in-flight request.
 */
async function ensureProxyConfigFresh(): Promise<void> {
    if (!proxyConfigSource) return;
    const isFresh = proxyConfigFetchedAt > 0 && PROXY_CONFIG_TTL_MS > 0 && Date.now() - proxyConfigFetchedAt < PROXY_CONFIG_TTL_MS;
    if (isFresh) return;
    if (refreshInProgress) {
        await refreshInProgress;
        return;
    }
    refreshInProgress = refreshProxyConfig();
    try {
        await refreshInProgress;
    } finally {
        refreshInProgress = null;
    }
}

/**
 * Check if a domain matches a domain pattern with wildcards
 * @param domainPattern Domain pattern with wildcards (e.g., "*.example.com")
 * @param hostname Hostname to test
 * @returns True if hostname matches the pattern
 */
function matchesDomainPattern(domainPattern: string, hostname: string): boolean {
    const regexPattern = domainPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special chars
        .replace(/\*/g, '.*')                   // Convert * to .*
        .replace(/\?/g, '.');                   // Convert ? to .

    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(hostname);
}

/**
 * Check if a URL matches a URL pattern with wildcards
 * @param urlPattern URL pattern with wildcards (e.g., "https://*.github.com/*")
 * @param url URL to test
 * @returns True if URL matches the pattern
 */
function matchesUrlPattern(urlPattern: string, url: string): boolean {
    const regexPattern = urlPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special chars
        .replace(/\*/g, '.*')                   // Convert * to .*
        .replace(/\?/g, '.');                   // Convert ? to .

    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(url);
}

/**
 * Resolve proxy mode to tiered proxy URLs with fallback support
 * Fallback rules:
 * - base: Only base proxies, no fallback
 * - stealth: Stealth proxies first, can fallback to base
 * - auto: Base first, fallback to stealth
 * - custom: Only the custom URL, no fallback
 *
 * @param proxyValue The proxy mode or custom URL from request
 * @returns Tiered proxy URLs array for fallback support
 */
export function resolveProxyModeWithFallback(proxyValue: string | undefined): (string | null)[][] | null {
    if (!proxyValue) {
        return null;
    }

    const baseProxyUrls = getBaseProxyUrls();
    const stealthProxyUrls = getStealthProxyUrls();

    if (proxyValue === 'base') {
        // Base mode: only base proxies, no upgrade to stealth
        if (baseProxyUrls.length === 0) {
            log.warning('[PROXY] Mode "base" requested but ANYCRAWL_PROXY_URL is not configured');
            return null;
        }
        // Single tier with base proxies only
        return [baseProxyUrls];
    }

    if (proxyValue === 'stealth') {
        // Stealth mode: stealth first, can fallback to base
        if (stealthProxyUrls.length === 0) {
            log.warning('[PROXY] Mode "stealth" requested but ANYCRAWL_PROXY_STEALTH_URL is not configured, falling back to base');
            if (baseProxyUrls.length === 0) {
                return null;
            }
            return [baseProxyUrls];
        }
        // Tier 0: stealth, Tier 1: base (fallback)
        if (baseProxyUrls.length > 0) {
            return [stealthProxyUrls, baseProxyUrls];
        }
        return [stealthProxyUrls];
    }

    if (proxyValue === 'auto') {
        // Auto mode: base first, fallback to stealth if base fails
        if (baseProxyUrls.length > 0) {
            // Tier 0: base, Tier 1: stealth (fallback)
            if (stealthProxyUrls.length > 0) {
                return [baseProxyUrls, stealthProxyUrls];
            }
            return [baseProxyUrls];
        }
        if (stealthProxyUrls.length > 0) {
            return [stealthProxyUrls];
        }
        log.warning('[PROXY] Mode "auto" requested but neither ANYCRAWL_PROXY_URL nor ANYCRAWL_PROXY_STEALTH_URL is configured');
        return null;
    }

    // Custom URL - no fallback allowed
    return [[proxyValue]];
}

/**
 * Resolve proxy mode or custom URL to actual proxy URL(s)
 * @param proxyValue The proxy mode or custom URL from request
 * @returns Array of proxy URLs to use, or null if no proxy
 */
export function resolveProxyMode(proxyValue: string | undefined): string[] | null {
    const tiered = resolveProxyModeWithFallback(proxyValue);
    if (!tiered || tiered.length === 0 || !tiered[0]) {
        return null;
    }
    // Return first tier (primary proxies)
    return tiered[0].filter((url): url is string => url !== null);
}

/**
 * Get a single proxy URL from resolved proxy mode with tier support
 * Rotates through available proxies using a simple counter
 * @param proxyValue The proxy mode or custom URL
 * @param proxyTier The tier to use (0 = primary, 1 = fallback)
 * @param requestUrl Optional request URL (currently unused)
 */
let proxyModeRotationIndex = 0;
export function getProxyFromMode(
  proxyValue: string | undefined,
  proxyTier: number = 0,
  requestUrl?: string
): string | null {
  const tiered = resolveProxyModeWithFallback(proxyValue);
  if (!tiered || tiered.length === 0) {
    return null;
  }

  // Use the specified tier, or fall back to last available tier
  const tierIndex = Math.min(proxyTier, tiered.length - 1);
  const tier = tiered[tierIndex];
  if (!tier) {
    return null;
  }
  const proxies = tier.filter((url): url is string => url !== null);

  if (proxies.length === 0) {
    return null;
  }

  // Simple rotation
  const proxy = proxies[proxyModeRotationIndex++ % proxies.length];
  return proxy || null;
}

/**
 * Check if a proxy mode allows fallback
 * @param proxyValue The proxy mode or custom URL
 * @returns true if fallback is allowed
 */
export function canProxyFallback(proxyValue: string | undefined): boolean {
    if (!proxyValue) return false;
    // base: no fallback (cannot upgrade)
    // stealth: can fallback to base
    // auto: can fallback
    // custom URL: no fallback
    return proxyValue === 'stealth' || proxyValue === 'auto';
}

/**
 * Get the number of proxy tiers available for a mode
 * @param proxyValue The proxy mode or custom URL
 * @returns Number of tiers available
 */
export function getProxyTierCount(proxyValue: string | undefined): number {
    const tiered = resolveProxyModeWithFallback(proxyValue);
    return tiered?.length || 0;
}

/**
 * Find matching proxy for a given URL based on the proxy configuration
 * @param requestUrl The URL to find proxy for
 * @returns Proxy URL if found, null otherwise
 */
function findProxyForUrl(requestUrl: string): string | null {
    if (!proxyConfig) return null;

    let urlObj: URL;
    try {
        urlObj = new URL(requestUrl);
    } catch (error) {
        log.info(`Invalid URL provided for proxy matching: ${requestUrl}`);
        return null;
    }
    if (!Array.isArray(proxyConfig.rules)) {
        log.warning('Proxy config rules is not an array, skipping proxy matching');
        return null;
    }
    for (const rule of proxyConfig.rules) {
        // Priority 1: Check exact URL match first (highest priority)
        if (rule.url && rule.url === requestUrl) {
            log.debug(`Proxy matched by exact URL rule: ${rule.url} → ${proxyConfigurationId(rule.proxy)}`);
            return rule.proxy;
        }
        // Priority 2: Check URL pattern match
        if (rule.pattern && matchesUrlPattern(rule.pattern, requestUrl)) {
            log.debug(`Proxy matched by URL pattern: ${rule.pattern} → ${proxyConfigurationId(rule.proxy)}`);
            return rule.proxy;
        }
        // Priority 3: Check domain pattern match (lowest priority)
        if (rule.domain && matchesDomainPattern(rule.domain, urlObj.hostname)) {
            log.debug(`Proxy matched by domain pattern: ${rule.domain} → ${proxyConfigurationId(rule.proxy)}`);
            return rule.proxy;
        }
    }

    log.debug(`No proxy rule matched for URL: ${requestUrl}`);
    return null;
}

/** Resolve permissions first; lease affinity never expands the selected candidates. */
async function selectStickyProxy(request: any, requestedTier = 0): Promise<string | null> {
    const data = request?.userData ?? {};
    const mode = data._originalProxy ?? data.options?.proxy;
    const matchUrl = data.original_url || request?.url;
    const rule = matchUrl ? findProxyForUrl(matchUrl) : null;
    const action = data._anycrawlRecoveryAction ?? 'none';
    const excluded = new Set<string>(data._anycrawlExcludedProxyIds ?? []);
    const cache = ProxyCacheManager.getInstance();
    const domain = matchUrl ? cache.extractDomain(matchUrl) : null;
    const entry = domain ? await cache.getStickyDomainEntry(domain) : null;
    const tiers = resolveProxyModeWithFallback(mode) ?? [getBaseProxyUrls()];
    let tier = Math.max(0, Math.min(Number.isFinite(requestedTier) ? requestedTier : 0, tiers.length - 1));
    if (mode === 'auto' && (action === 'upgrade' || data._anycrawlSelectedMode === 'stealth' || entry?.mode === 'stealth')) {
        const stealth = getStealthProxyUrls();
        const index = tiers.findIndex(values => values.some(value => value && stealth.includes(value)));
        if (index >= 0) tier = index;
    }
    let candidates = (tiers[tier] ?? []).filter((value): value is string => Boolean(value));
    if (rule && action === 'none') candidates = [rule];
    else if (rule) candidates = [...new Set([rule, ...tiers.flat().filter((value): value is string => Boolean(value))])];
    candidates = candidates.filter(value => !excluded.has(proxyConfigurationId(value)));
    // Authentication excludes a configuration, not merely its current session. Only allowed tiers may supply a backup.
    if (!candidates.length && action !== 'none' && !rule) {
        candidates = tiers.flat().filter((value): value is string => Boolean(value) && !excluded.has(proxyConfigurationId(value!)));
    }
    if (!candidates.length) {
        if (action !== 'none' || mode || rule) throw new StickyProxyConfigurationError('No permitted sticky proxy candidate remains');
        return null;
    }
    const cached = tier === 0 && mode === 'stealth' || mode === 'auto' && entry?.mode === 'stealth'
        ? entry?.stealthWorkingProxy : entry?.baseWorkingProxy;
    const selected = stickyLeasePreference.getStore()?.(candidates)
        ?? (action === 'none' && cached && candidates.includes(cached) ? cached : candidates[proxyModeRotationIndex++ % candidates.length]!);
    const actualMode = getStealthProxyUrls().includes(selected) ? 'stealth' : getBaseProxyUrls().includes(selected) ? 'base' : 'custom';
    data._anycrawlSelectedMode = actualMode;
    data._anycrawlStickyCachePolicy = 2;
    // Keep the caller's permissions separately while exposing the actual tier to existing solver/billing paths.
    if (isProxyMode(mode)) { data._originalProxy ??= mode; data.options.proxy = actualMode === 'custom' ? mode : actualMode; }
    return selected;
}


const proxyConfiguration = new ProxyConfiguration({
    newUrlFunction: async (_sessionId: string | number, options?: { request?: Request; proxyTier?: number }): Promise<string | null> => {
        if (stickyProxySelection.getStore()) return selectStickyProxy(options?.request, (options?.request?.userData as any)?._proxyTier ?? options?.proxyTier);
        const requestUrl = options?.request?.url || 'unknown';
        const originalUrl = (options?.request?.userData as any)?.original_url;
        const matchUrl = originalUrl || requestUrl;
        const retryCountRaw = Number((options?.request as any)?.retryCount);
        const retryCount = Number.isFinite(retryCountRaw) && retryCountRaw >= 0
            ? Math.floor(retryCountRaw)
            : 0;
        const userDataTier = (options?.request?.userData as any)?._proxyTier;
        const proxyTierRaw = (options as any)?.proxyTier;
        const proxyTier =
            typeof userDataTier === 'number' && Number.isFinite(userDataTier)
                ? userDataTier
                : (typeof proxyTierRaw === 'number' && Number.isFinite(proxyTierRaw) ? proxyTierRaw : 0);

        // Check proxy.config.json for domain-specific rules
        const ruleMatch = matchUrl ? findProxyForUrl(matchUrl) : null;

        // On first attempt, prefer the config rule proxy (highest priority).
        // On retries, fall through to merge with proxy mode proxies for rotation.
        if (ruleMatch && retryCount === 0) {
            log.info(`[PROXY] URL: ${requestUrl}${originalUrl && originalUrl !== requestUrl ? ` (original: ${originalUrl})` : ''} → Matched proxy config rule: ${proxyConfigurationId(ruleMatch)}`);
            return ruleMatch;
        }

        // Next: explicit proxy from request userData (supports modes: auto, base, stealth, or custom URL)
        if (options?.request?.userData?.options?.proxy) {
            const proxyValue = options.request.userData.options.proxy;

            // Check if it's a proxy mode or custom URL
            if (isProxyMode(proxyValue)) {
                const proxyCache = ProxyCacheManager.getInstance();
                const domain = matchUrl ? proxyCache.extractDomain(matchUrl) : null;
                const domainEntry = domain ? await proxyCache.getDomainCacheEntry(domain) : null;

                // Apply cached mode upgrade for auto mode (cross-job persistence).
                // If a domain has already proven to require stealth, skip base attempts directly.
                let effectiveProxyMode: ProxyMode = proxyValue;
                if (proxyValue === 'auto' && domainEntry?.mode === 'stealth') {
                    effectiveProxyMode = 'stealth';
                    options.request.userData._originalProxy = options.request.userData._originalProxy ?? proxyValue;
                    options.request.userData.options.proxy = 'stealth';
                    log.info(`[ProxyCache] Domain ${domain} cached mode=stealth, upgrading proxy mode auto -> stealth for ${requestUrl}`);
                }

                // Prefer the last known working proxy for this domain+mode when available.
                if (domain && (effectiveProxyMode === 'base' || effectiveProxyMode === 'stealth')) {
                    const cachedWorkingProxy = effectiveProxyMode === 'base'
                        ? domainEntry?.baseWorkingProxy
                        : domainEntry?.stealthWorkingProxy;
                    const allowed = resolveProxyModeWithFallback(effectiveProxyMode)?.flat() ?? [];
                    const usableCache = !stickyProxySelection.getStore() || (
                        retryCount === 0 && proxyTier === 0 && cachedWorkingProxy?.includes(STICKY_SESSION_TOKEN) && allowed.includes(cachedWorkingProxy)
                    );
                    if (cachedWorkingProxy && usableCache) {
                        const isFailed = await proxyCache.isProxyFailureActive(domain, cachedWorkingProxy);
                        if (!isFailed) {
                            log.info(`[PROXY] URL: ${requestUrl}${originalUrl && originalUrl !== requestUrl ? ` (original: ${originalUrl})` : ''} → Using cached ${effectiveProxyMode} proxy: ${proxyConfigurationId(cachedWorkingProxy)}`);
                            return cachedWorkingProxy;
                        }
                        log.info(`[ProxyCache] Cached working proxy is currently failed, falling back to rotation: ${domain}@${proxyConfigurationId(cachedWorkingProxy)}`);
                    }
                }

                let effectiveProxyTier = proxyTier;

                // Auto mode: use base tier first, retry will upgrade to stealth
                if (effectiveProxyMode === 'auto' && retryCount >= 1) {
                    effectiveProxyTier = 1;
                }

                // Merge: config rule proxy + mode proxies for rotation on retries
                if (ruleMatch && retryCount > 0) {
                    const tiered = resolveProxyModeWithFallback(effectiveProxyMode);
                    const modeProxies = tiered
                        ? tiered.flat().filter((u): u is string => !!u && u !== ruleMatch)
                        : [];
                    const combined = [ruleMatch, ...modeProxies];
                    const selectedProxy = combined[proxyModeRotationIndex++ % combined.length];
                    if (selectedProxy) {
                        log.info(`[PROXY] URL: ${requestUrl}${originalUrl && originalUrl !== requestUrl ? ` (original: ${originalUrl})` : ''} → Config rule + ${effectiveProxyMode} rotation (retry=${retryCount}, pool=${combined.length}): ${proxyConfigurationId(selectedProxy)}`);
                        return selectedProxy;
                    }
                }

                const resolvedProxy = getProxyFromMode(effectiveProxyMode, effectiveProxyTier, matchUrl);
                if (resolvedProxy) {
                    const tierCount = getProxyTierCount(effectiveProxyMode);
                    const tierInfo = tierCount > 1 ? ` (tier ${effectiveProxyTier}/${tierCount - 1})` : '';
                    log.info(`[PROXY] URL: ${requestUrl}${originalUrl && originalUrl !== requestUrl ? ` (original: ${originalUrl})` : ''} → Using proxy mode "${effectiveProxyMode}"${tierInfo}: ${proxyConfigurationId(resolvedProxy)}`);
                    return resolvedProxy;
                }
                log.debug(`[PROXY] URL: ${requestUrl} → Proxy mode "${effectiveProxyMode}" resolved to no proxy`);
            } else {
                // Custom proxy URL - no fallback allowed
                log.info(`[PROXY] URL: ${requestUrl}${originalUrl && originalUrl !== requestUrl ? ` (original: ${originalUrl})` : ''} → Using custom proxy from userData: ${proxyConfigurationId(proxyValue)}`);
                return proxyValue;
            }
        }

        // If config rule matched but no proxy mode set, merge with ANYCRAWL_PROXY_URL for rotation
        if (ruleMatch && retryCount > 0) {
            const envProxies = (process.env.ANYCRAWL_PROXY_URL?.split(',') || [])
                .map(u => u.trim()).filter(u => u && u !== ruleMatch);
            const combined = [ruleMatch, ...envProxies];
            const selectedProxy = combined[proxyModeRotationIndex++ % combined.length];
            if (selectedProxy) {
                log.info(`[PROXY] URL: ${requestUrl}${originalUrl && originalUrl !== requestUrl ? ` (original: ${originalUrl})` : ''} → Config rule + env rotation (retry=${retryCount}, pool=${combined.length}): ${proxyConfigurationId(selectedProxy)}`);
                return selectedProxy;
            }
        }

        // If config rule matched but this is the only proxy available, use it
        if (ruleMatch) {
            log.info(`[PROXY] URL: ${requestUrl}${originalUrl && originalUrl !== requestUrl ? ` (original: ${originalUrl})` : ''} → Matched proxy config rule (no other proxies for rotation): ${proxyConfigurationId(ruleMatch)}`);
            return ruleMatch;
        }

        // Fallback to ANYCRAWL_PROXY_URL (handled by tieredProxyUrls)
        if (process.env.ANYCRAWL_PROXY_URL) {
            log.info(`[PROXY] URL: ${requestUrl}${originalUrl && originalUrl !== requestUrl ? ` (original: ${originalUrl})` : ''} → No rule matched, will use ANYCRAWL_PROXY_URL fallback`);
        } else {
            log.info(`[PROXY] URL: ${requestUrl}${originalUrl && originalUrl !== requestUrl ? ` (original: ${originalUrl})` : ''} → No proxy configured (no rule matched, no ANYCRAWL_PROXY_URL)`);
        }
        return null;
    },
    // Fallback proxy configuration from ANYCRAWL_PROXY_URL environment variable
    // Supports both single proxy and comma-separated multiple proxies
    tieredProxyUrls: process.env.ANYCRAWL_PROXY_URL?.split(',').map(url => [url.trim()])
});

export default proxyConfiguration;
