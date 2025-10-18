import { Request, ProxyConfiguration as CrawleeProxyConfiguration } from "crawlee";
import { log } from "@anycrawl/libs/log";
import type { Dictionary } from '@crawlee/types';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as http from 'http';
import * as https from 'https';

import { cryptoRandomObjectId } from '@apify/utilities';

export interface ProxyConfigurationFunction {
    (sessionId: string | number, options?: { request?: Request }): string | null | Promise<string | null>;
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
        if (typeof sessionId === 'number') sessionId = `${sessionId}`;

        let url: string | undefined | null;
        let tier: number | undefined;

        // First try newUrlFunction
        if (this.newUrlFunction) {
            const result = await this._callNewUrlFunction(sessionId, { request: options?.request });
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

        const { username, password, port, hostname } = new URL(url);

        return {
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
                    this.log.info(`Using merged proxy list (rule + fallback): ${selectedProxy} for URL: ${options.request.url}`);
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
                this.log.info(`Using tiered proxy: ${selectedProxy}`);
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
        if (selectedProxy && options?.request?.url) {
            this.log.info(`Using tiered proxy from tier ${tierPrediction}: ${selectedProxy} for URL: ${options.request.url}`);
        } else if (selectedProxy) {
            this.log.info(`Using tiered proxy from tier ${tierPrediction}: ${selectedProxy}`);
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

        // First try newUrlFunction
        if (this.newUrlFunction) {
            const result = await this._callNewUrlFunction(sessionId, { request: options?.request });
            if (result) {
                return result;
            }
        }

        // If newUrlFunction returns null, try tieredProxyUrls
        if (this.tieredProxyUrls) {
            return this._handleTieredUrl(sessionId ?? cryptoRandomObjectId(6), options).proxyUrl ?? undefined;
        }

        // If both fail, try custom URLs as fallback
        if (this.proxyUrls && this.proxyUrls.length > 0) {
            return this._handleCustomUrl(sessionId) ?? undefined;
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

// Parse proxy configuration from file specified by environment variable
let proxyConfig: ProxyConfig | null = null;

function loadProxyConfigFromFile(pathOrFileUrl: string): void {
    try {
        const pathToRead = resolve(pathOrFileUrl);
        const configContent = readFileSync(pathToRead, 'utf-8');
        const parsed: ProxyConfig = JSON.parse(configContent);
        proxyConfig = parsed;
        if (proxyConfig?.rules) {
            log.info(`Loaded proxy configuration from ${pathToRead} with ${proxyConfig.rules.length} rules`);
        }
    } catch (error) {
        log.error('Failed to load proxy configuration from file', {
            configPath: pathOrFileUrl,
            error
        });
    }
}

function loadProxyConfigFromHttp(urlStr: string): void {
    try {
        const urlObj = new URL(urlStr);
        const lib = urlObj.protocol === 'https:' ? https : http;
        const req = lib.request(urlObj, (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                log.error(`Failed to load proxy configuration from URL: HTTP ${res.statusCode}`, { url: urlStr });
                res.resume();
                return;
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed: ProxyConfig = JSON.parse(data);
                    proxyConfig = parsed;
                    if (proxyConfig?.rules) {
                        log.info(`Loaded proxy configuration from ${urlStr} with ${proxyConfig.rules.length} rules`);
                    }
                } catch (e) {
                    log.error('Failed to parse proxy configuration JSON from URL', { url: urlStr, error: e });
                }
            });
        });
        req.on('error', (e) => {
            log.error('Failed to load proxy configuration from URL', { url: urlStr, error: e });
        });
        req.end();
    } catch (error) {
        log.error('Invalid ANYCRAWL_PROXY_CONFIG URL', { url: urlStr, error });
    }
}

if (process.env.ANYCRAWL_PROXY_CONFIG) {
    const cfg = process.env.ANYCRAWL_PROXY_CONFIG.trim();
    if (cfg.startsWith('http://') || cfg.startsWith('https://')) {
        loadProxyConfigFromHttp(cfg);
    } else {
        loadProxyConfigFromFile(cfg);
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
            log.debug(`Proxy matched by exact URL rule: ${rule.url} → ${rule.proxy}`);
            return rule.proxy;
        }
        // Priority 2: Check URL pattern match
        if (rule.pattern && matchesUrlPattern(rule.pattern, requestUrl)) {
            log.debug(`Proxy matched by URL pattern: ${rule.pattern} → ${rule.proxy}`);
            return rule.proxy;
        }
        // Priority 3: Check domain pattern match (lowest priority)
        if (rule.domain && matchesDomainPattern(rule.domain, urlObj.hostname)) {
            log.debug(`Proxy matched by domain pattern: ${rule.domain} → ${rule.proxy}`);
            return rule.proxy;
        }
    }

    log.debug(`No proxy rule matched for URL: ${requestUrl}`);
    return null;
}

const proxyConfiguration = new ProxyConfiguration({
    newUrlFunction: (_sessionId: string | number, options?: { request?: Request }): string | null => {
        // First priority: explicit proxy from request userData
        if (options?.request?.userData?.options?.proxy) {
            log.info(`Using proxy from request userData: ${options?.request?.userData?.options?.proxy}`);
            return options?.request?.userData?.options?.proxy;
        }

        // Next: proxy rule matching should use original_url first if available
        const matchUrl = (options?.request?.userData as any)?.original_url || options?.request?.url;
        if (matchUrl) {
            const matched = findProxyForUrl(matchUrl);
            if (matched) {
                log.info(`Found proxy for URL ${matchUrl}: ${matched} By matching a rule.`);
                return matched;
            }
        }

        // Fallback to ANYCRAWL_PROXY_URL (handled by tieredProxyUrls)
        return null;
    },
    // Fallback proxy configuration from ANYCRAWL_PROXY_URL environment variable
    // Supports both single proxy and comma-separated multiple proxies
    tieredProxyUrls: process.env.ANYCRAWL_PROXY_URL?.split(',').map(url => [url.trim()])
});

export default proxyConfiguration;
