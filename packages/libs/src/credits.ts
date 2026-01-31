/**
 * Resolved proxy mode for credit calculation
 */
export type ResolvedProxyMode = 'base' | 'stealth' | 'custom';

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
     * Get the resolved proxy mode name for credit calculation
     */
    static getResolvedProxyMode(proxyValue: string | undefined): ResolvedProxyMode {
        if (!proxyValue || proxyValue === 'base') {
            return 'base';
        }

        if (proxyValue === 'stealth') {
            return 'stealth';
        }

        if (proxyValue === 'auto') {
            const stealthProxyUrls = process.env.ANYCRAWL_PROXY_STEALTH_URL?.split(',').map(url => url.trim()).filter(Boolean) || [];
            if (stealthProxyUrls.length > 0) {
                return 'stealth';
            }
            return 'base';
        }

        // Custom URL
        return 'custom';
    }

    /**
     * Get proxy credits (extra credits for stealth proxy)
     * - base: 0 credits
     * - stealth: configurable via ANYCRAWL_PROXY_STEALTH_CREDITS (default: 2)
     * - custom: 0 credits
     */
    static getProxyCredits(proxyValue: string | undefined): number {
        const mode = this.getResolvedProxyMode(proxyValue);
        if (mode === 'stealth') {
            return Number.parseInt(process.env.ANYCRAWL_PROXY_STEALTH_CREDITS || '2', 10);
        }
        return 0;
    }

    /**
     * Get JSON extraction credits
     * Returns extra credits for JSON extraction, doubled if extract_source is 'html'
     */
    static getJsonExtractionCredits(options: ScrapeCreditsOptions): number {
        const extractJsonCredits = Number.parseInt(process.env.ANYCRAWL_EXTRACT_JSON_CREDITS || '0', 10);

        const hasJsonOptions = Boolean(options.json_options) && options.formats?.includes('json');
        if (!hasJsonOptions || !Number.isFinite(extractJsonCredits) || extractJsonCredits <= 0) {
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
     * Formula: 1 (base) + proxy credits
     * Note: JSON extraction credits are calculated per-page in Progress.ts
     */
    static calculateCrawlInitialCredits(options: CrawlCreditsOptions = {}): number {
        const baseCredits = 1;
        const proxyCredits = this.getProxyCredits(options.scrape_options?.proxy);

        return baseCredits + proxyCredits;
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
    return CreditCalculator.getResolvedProxyMode(proxyValue);
}

export function getProxyCredits(proxyMode: ResolvedProxyMode): number {
    if (proxyMode === 'stealth') {
        return Number.parseInt(process.env.ANYCRAWL_PROXY_STEALTH_CREDITS || '2', 10);
    }
    return 0;
}

export function calculateProxyCredits(proxyValue: string | undefined): number {
    return CreditCalculator.getProxyCredits(proxyValue);
}

/**
 * Pre-calculate (estimate) minimum credits required for a task before execution
 */
export function estimateTaskCredits(
    taskType: string,
    taskPayload: any,
    options?: {
        template?: any;
    }
): number {
    try {
        let baseCredits = 1;
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
            baseCredits = 1;
        } else if (actualTaskType === "search") {
            const pages = actualPayload.pages || 1;
            baseCredits = pages;
            if (actualPayload.scrape_options) {
                const limit = actualPayload.limit || 10;
                baseCredits += limit;
            }
        } else if (actualTaskType === "crawl") {
            const limit = actualPayload.limit || actualPayload.options?.limit || 10;
            baseCredits = limit;
        }

        return baseCredits + templateCredits;
    } catch (error) {
        console.error(`Error estimating task credits: ${error}`);
        return 1;
    }
}
