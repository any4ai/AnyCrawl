import { getResolvedProxyMode, type ResolvedProxyMode } from "./proxy.js";

/**
 * Default credit values
 */
const DEFAULT_PROXY_STEALTH_CREDITS = 2;
const DEFAULT_EXTRACT_JSON_CREDITS = 0;

/**
 * Safely parse integer from environment variable with fallback
 */
function safeParseInt(value: string | undefined, defaultValue: number): number {
    if (!value) return defaultValue;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Options for calculating scrape credits
 */
export interface ScrapeCreditsOptions {
    proxy?: string;
    json_options?: any;
    formats?: string[];
    extract_source?: string;
}

/**
 * Options for calculating crawl credits
 */
export interface CrawlCreditsOptions {
    scrape_options?: ScrapeCreditsOptions;
}

/**
 * Options for calculating search credits
 */
export interface SearchCreditsOptions {
    pages?: number;
    scrape_options?: ScrapeCreditsOptions & { engine?: string };
    completedScrapeCount?: number;
}

/**
 * Centralized credit calculation class
 * Handles all credit calculations for scrape, crawl, and search operations
 */
export class CreditCalculator {
    /**
     * Get proxy credits (extra credits for stealth proxy)
     * - base: 0 credits
     * - stealth: configurable via ANYCRAWL_PROXY_STEALTH_CREDITS (default: 2)
     * - custom: 0 credits
     */
    static getProxyCredits(proxyValue: string | undefined): number {
        const mode = getResolvedProxyMode(proxyValue);
        if (mode === 'stealth') {
            return safeParseInt(process.env.ANYCRAWL_PROXY_STEALTH_CREDITS, DEFAULT_PROXY_STEALTH_CREDITS);
        }
        return 0;
    }

    /**
     * Get JSON extraction credits
     * Returns extra credits for JSON extraction, doubled if extract_source is 'html'
     */
    static getJsonExtractionCredits(options: ScrapeCreditsOptions): number {
        const extractJsonCredits = safeParseInt(process.env.ANYCRAWL_EXTRACT_JSON_CREDITS, DEFAULT_EXTRACT_JSON_CREDITS);

        const hasJsonOptions = Boolean(options.json_options) && options.formats?.includes('json');
        if (!hasJsonOptions || extractJsonCredits <= 0) {
            return 0;
        }

        const extractSource = options.extract_source || 'markdown';
        // Double credits for HTML extraction
        return extractSource === 'html' ? extractJsonCredits * 2 : extractJsonCredits;
    }

    /**
     * Calculate total credits for a single scrape operation
     * Formula: 1 (base) + proxy credits + JSON extraction credits
     */
    static calculateScrapeCredits(options: ScrapeCreditsOptions = {}): number {
        const baseCredits = 1;
        const proxyCredits = this.getProxyCredits(options.proxy);
        const jsonCredits = this.getJsonExtractionCredits(options);

        return baseCredits + proxyCredits + jsonCredits;
    }

    /**
     * Calculate initial credits for a crawl job (first page)
     * Formula: Same as per-page (1 + proxy + JSON)
     */
    static calculateCrawlInitialCredits(options: CrawlCreditsOptions = {}): number {
        return this.calculateCrawlPageCredits(options.scrape_options || {});
    }

    /**
     * Calculate credits for a single crawl page
     * Formula: 1 (base) + proxy credits + JSON extraction credits
     */
    static calculateCrawlPageCredits(options: ScrapeCreditsOptions = {}): number {
        return this.calculateScrapeCredits(options);
    }

    /**
     * Calculate total credits for a search operation
     * Formula: page credits + (scrape credits per result * completed scrapes)
     */
    static calculateSearchCredits(options: SearchCreditsOptions = {}): number {
        const pageCredits = options.pages ?? 1;

        if (!options.scrape_options || !options.completedScrapeCount || options.completedScrapeCount <= 0) {
            return pageCredits;
        }

        const perScrapeCredits = this.calculateScrapeCredits(options.scrape_options);
        const scrapeCredits = options.completedScrapeCount * perScrapeCredits;

        return pageCredits + scrapeCredits;
    }
}

// Export legacy functions for backward compatibility
export function getResolvedProxyModeForCredits(proxyValue: string | undefined): ResolvedProxyMode {
    return getResolvedProxyMode(proxyValue);
}

export function getProxyCredits(proxyMode: ResolvedProxyMode): number {
    if (proxyMode === 'stealth') {
        return safeParseInt(process.env.ANYCRAWL_PROXY_STEALTH_CREDITS, DEFAULT_PROXY_STEALTH_CREDITS);
    }
    return 0;
}

export function calculateProxyCredits(proxyValue: string | undefined): number {
    return CreditCalculator.getProxyCredits(proxyValue);
}

/**
 * Pre-calculate (estimate) minimum credits required for a task before execution
 * Uses CreditCalculator for accurate calculation
 */
export function estimateTaskCredits(
    taskType: string,
    taskPayload: any,
    options?: {
        template?: any;
    }
): number {
    try {
        let templateCredits = 0;
        let actualTaskType = taskType;
        let actualPayload = taskPayload;

        if (options?.template) {
            const template = options.template;
            actualTaskType = template.templateType || taskType;
            actualPayload = {
                ...(template.reqOptions || {}),
                ...taskPayload
            };
            templateCredits = template.pricing?.perCall || 0;
        }

        if (actualTaskType === "scrape") {
            const scrapeOptions = actualPayload.options || actualPayload;
            return templateCredits + CreditCalculator.calculateScrapeCredits({
                proxy: scrapeOptions.proxy,
                json_options: scrapeOptions.json_options,
                formats: scrapeOptions.formats,
                extract_source: scrapeOptions.extract_source,
            });
        }

        if (actualTaskType === "search") {
            const pages = actualPayload.pages || 1;
            let scrapeCredits = 0;

            if (actualPayload.scrape_options) {
                const perScrapeCredits = CreditCalculator.calculateScrapeCredits({
                    proxy: actualPayload.scrape_options.proxy,
                    json_options: actualPayload.scrape_options.json_options,
                    formats: actualPayload.scrape_options.formats,
                    extract_source: actualPayload.scrape_options.extract_source,
                });
                const limit = actualPayload.limit || 10;
                scrapeCredits = perScrapeCredits * limit;
            }

            return templateCredits + pages + scrapeCredits;
        }

        if (actualTaskType === "crawl") {
            const limit = actualPayload.limit || actualPayload.options?.limit || 10;
            const scrapeOptions = actualPayload.options?.scrape_options || actualPayload.scrape_options || {};

            const perPageCredits = CreditCalculator.calculateCrawlPageCredits({
                proxy: scrapeOptions.proxy,
                json_options: scrapeOptions.json_options,
                formats: scrapeOptions.formats,
                extract_source: scrapeOptions.extract_source,
            });

            return templateCredits + (perPageCredits * limit);
        }

        // Unknown type, return conservative estimate
        return templateCredits + 1;
    } catch (error) {
        console.error(`Error estimating task credits: ${error}`);
        return 1;
    }
}
