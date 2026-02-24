/**
 * Proxy modes supported by the system
 * - "auto": Automatically decide between base and stealth proxy, base first then fallback to stealth
 * - "base": Use ANYCRAWL_PROXY_URL (default), cannot upgrade to stealth
 * - "stealth": Use ANYCRAWL_PROXY_STEALTH_URL, can downgrade to base on failure
 * - Custom URL: A full proxy URL string, cannot switch
 */
export type ProxyMode = 'auto' | 'base' | 'stealth';

/**
 * Resolved proxy mode for responses and credit calculation
 * - "base": Using ANYCRAWL_PROXY_URL
 * - "stealth": Using ANYCRAWL_PROXY_STEALTH_URL
 * - "custom": Using a custom proxy URL
 */
export type ResolvedProxyMode = 'base' | 'stealth' | 'custom';

/**
 * Check if a string is a proxy mode keyword
 */
export function isProxyMode(value: string | undefined): value is ProxyMode {
    return value === 'auto' || value === 'base' || value === 'stealth';
}

/**
 * Parse proxy URLs from environment variable
 * Supports comma-separated URLs
 */
export function parseProxyUrls(envValue: string | undefined): string[] {
    if (!envValue) return [];
    return envValue.split(',').map(url => url.trim()).filter(Boolean);
}

/**
 * Get base proxy URLs from environment
 */
export function getBaseProxyUrls(): string[] {
    return parseProxyUrls(process.env.ANYCRAWL_PROXY_URL);
}

/**
 * Get stealth proxy URLs from environment
 */
export function getStealthProxyUrls(): string[] {
    return parseProxyUrls(process.env.ANYCRAWL_PROXY_STEALTH_URL);
}

/**
 * Get the resolved proxy mode name for response/credit calculation
 * @param proxyValue The proxy mode or custom URL from request
 * @returns The resolved mode name: 'base', 'stealth', or 'custom'
 */
export function getResolvedProxyMode(proxyValue: string | undefined): ResolvedProxyMode {
    if (!proxyValue || proxyValue === 'base') {
        return 'base';
    }

    if (proxyValue === 'stealth') {
        const stealthProxyUrls = getStealthProxyUrls();
        return stealthProxyUrls.length > 0 ? 'stealth' : 'base';
    }

    if (proxyValue === 'auto') {
        // Auto mode: base first, fallback to stealth - charge base rate initially
        return 'base';
    }

    // Custom URL
    return 'custom';
}
