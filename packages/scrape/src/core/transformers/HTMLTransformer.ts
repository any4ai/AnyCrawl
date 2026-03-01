export interface ExtractionOptions {
    include_tags?: string[];
    exclude_tags?: string[];
    only_main_content?: boolean;
}

export interface TransformOptions extends ExtractionOptions {
    baseUrl?: string;
    transformRelativeUrls?: boolean;
}

interface ImageSource {
    url: string;
    size: number;
    isPixelDensity: boolean;
}

/**
 * Technical tags that should always be removed regardless of only_main_content setting
 */
const ALWAYS_REMOVE_TAGS: string[] = [
    "script",
    "style",
    "noscript"
];

/**
 * Non-main content tags and selectors to exclude when only_main_content is true
 * Based on Firecrawl's implementation with additional common patterns
 */
const EXCLUDE_NON_MAIN_TAGS: string[] = [
    // Semantic HTML5 tags
    "header",
    "footer",
    "nav",
    "aside",

    // Header patterns
    ".header",
    ".top",
    ".navbar",
    "#header",
    ".site-header",
    ".page-header",

    // Footer patterns
    ".footer",
    ".bottom",
    "#footer",
    ".site-footer",
    ".page-footer",

    // Sidebar patterns
    ".sidebar",
    ".side",
    ".aside",
    "#sidebar",
    ".left-sidebar",
    ".right-sidebar",

    // Modal/Popup/Overlay
    ".modal",
    ".popup",
    "#modal",
    ".overlay",
    ".dialog",
    ".lightbox",

    // Advertisement
    ".ad",
    ".ads",
    ".advert",
    "#ad",
    ".advertisement",
    ".banner-ad",

    // Language/Locale selector
    ".lang-selector",
    ".language",
    "#language-selector",
    ".locale-selector",

    // Social media
    ".social",
    ".social-media",
    ".social-links",
    "#social",
    ".social-share",
    ".share-buttons",

    // Navigation/Menu
    ".menu",
    ".navigation",
    "#nav",
    ".nav-menu",
    ".site-nav",

    // Breadcrumbs
    ".breadcrumbs",
    "#breadcrumbs",
    ".breadcrumb",

    // Share buttons
    ".share",
    "#share",

    // NOTE:
    // Avoid removing generic ".widget" containers globally. Many sites (e.g. publisher
    // platforms) wrap their primary article body in widget-like classes such as
    // ".widget-ArticleFulltext". Removing ".widget" causes core content like abstracts
    // to be dropped under only_main_content mode.

    // Cookie notices
    ".cookie",
    "#cookie",
    ".cookie-banner",
    ".cookie-notice",
    ".cookie-consent",

    // // Comments (often not main content)
    // ".comments",
    // "#comments",
    // ".comment-section",

    // Related content (often sidebar)
    ".related",
    ".related-posts",
    ".related-articles",

    // Firecrawl decoration
    ".fc-decoration"
];

/**
 * Force include main content tags even if they match EXCLUDE_NON_MAIN_TAGS
 * These selectors identify important main content that should never be removed
 */
const FORCE_INCLUDE_MAIN_TAGS: string[] = [
    // Main content identifiers
    "#main",
    "main",
    "[role='main']",
    ".main-content",
    ".content-main",

    // Article content
    "article",
    ".article",
    ".post-content",
    ".entry-content",

    // Swoogo event platform (from Firecrawl)
    ".swoogo-cols",
    ".swoogo-text",
    ".swoogo-table-div",
    ".swoogo-space",
    ".swoogo-alert",
    ".swoogo-sponsors",
    ".swoogo-title",
    ".swoogo-tabs",
    ".swoogo-logo",
    ".swoogo-image",
    ".swoogo-button",
    ".swoogo-agenda"
];

/**
 * HTML Transformer for processing and cleaning HTML content
 * Handles HTML extraction, cleaning, and transformation operations
 */
export class HTMLTransformer {
    /**
     * Transform HTML content with URL resolution and cleaning
     * Supports include_tags functionality, relative URL transformation, and preserves original HTML structure
     */
    async transformHtml($: any, baseUrl: string, options?: TransformOptions): Promise<string> {
        // Clone the cheerio instance to avoid modifying the original
        const $clone = $.load($.html());

        // Transform relative URLs if requested
        if (options?.transformRelativeUrls !== false) {
            await this.transformRelativeUrls($clone, baseUrl);
        }

        // Apply cleaning and extraction logic directly on the already cloned instance
        return this.doExtractCleanHtml($clone, options);
    }

    /**
     * Extract clean HTML content
     * Supports include_tags functionality and preserves original HTML structure
     */
    extractCleanHtml($: any, options?: ExtractionOptions): string {
        // Clone the cheerio instance to avoid modifying the original
        const $clone = $.load($.html());

        return this.doExtractCleanHtml($clone, options);
    }

    /**
     * Internal method to perform the actual HTML cleaning and extraction
     * Works on an already cloned cheerio instance to avoid redundant cloning
     */
    private doExtractCleanHtml($: any, options?: ExtractionOptions): string {
        // Always remove technical tags first (script, style, noscript)
        $(ALWAYS_REMOVE_TAGS.join(', ')).remove();

        // If include_tags is specified, only extract those elements
        if (options?.include_tags && options.include_tags.length > 0) {
            // Create new document to collect matching elements
            const $newDocument = $.load("<div></div>");
            const $root = $newDocument('div');

            // For each include tag selector, find matching elements and add them
            for (const selector of options.include_tags) {
                const matchingElements = $(selector);
                matchingElements.each((_: number, element: any) => {
                    // Clone the element and append to root
                    const clonedElement = $(element).clone();
                    $root.append(clonedElement);
                });
            }

            return $root.html() || '';
        } else {
            // Standard extraction: preserve original structure, only remove unwanted elements

            // Apply only_main_content filtering (default: true)
            const shouldFilterMainContent = options?.only_main_content !== false;

            if (shouldFilterMainContent) {
                // Remove non-main content elements, but preserve elements containing FORCE_INCLUDE_MAIN_TAGS
                for (const excludeSelector of EXCLUDE_NON_MAIN_TAGS) {
                    const matchingElements = $(excludeSelector);
                    matchingElements.each((_: number, element: any) => {
                        const $element = $(element);

                        // Check if this element contains any force-include main content tags
                        let shouldKeep = false;
                        for (const includeSelector of FORCE_INCLUDE_MAIN_TAGS) {
                            if ($element.find(includeSelector).length > 0) {
                                shouldKeep = true;
                                break;
                            }
                        }

                        // Remove element if it doesn't contain force-include tags
                        if (!shouldKeep) {
                            $element.remove();
                        }
                    });
                }
            }

            // Apply exclude_tags if specified
            if (options?.exclude_tags && options.exclude_tags.length > 0) {
                for (const selector of options.exclude_tags) {
                    $(selector).remove();
                }
            }

            // Remove comments
            $('*').contents().filter(function (this: any) {
                return this.type === 'comment';
            }).remove();

            // Return the complete original HTML structure (preserves DOCTYPE, html, head, body, etc.)
            return $.html();
        }
    }

    /**
     * Extract specific elements based on CSS selectors
     * Similar to Firecrawl's include_tags functionality
     */
    extractElementsBySelectors($: any, selectors: string[]): string {
        const $clone = $.load($.html());
        const $newDocument = $.load("<div></div>");
        const $root = $newDocument('div');

        for (const selector of selectors) {
            const matchingElements = $clone(selector);
            matchingElements.each((_: number, element: any) => {
                const clonedElement = $clone(element).clone();
                $root.append(clonedElement);
            });
        }

        return $root.html() || '';
    }

    /**
     * Remove specific elements based on CSS selectors
     */
    removeElementsBySelectors($: any, selectors: string[]): any {
        const $clone = $.load($.html());

        for (const selector of selectors) {
            $clone(selector).remove();
        }

        return $clone;
    }

    /**
     * Clean HTML by removing unwanted elements and comments
     * Uses the EXCLUDE_NON_MAIN_TAGS constant for comprehensive cleaning
     */
    cleanHtml($: any): any {
        const $clone = $.load($.html());

        // Always remove technical tags first
        $clone(ALWAYS_REMOVE_TAGS.join(', ')).remove();

        // Remove unwanted elements using the constant
        for (const excludeSelector of EXCLUDE_NON_MAIN_TAGS) {
            const matchingElements = $clone(excludeSelector);
            matchingElements.each((_: number, element: any) => {
                const $element = $clone(element);

                // Check if this element contains any force-include main content tags
                let shouldKeep = false;
                for (const includeSelector of FORCE_INCLUDE_MAIN_TAGS) {
                    if ($element.find(includeSelector).length > 0) {
                        shouldKeep = true;
                        break;
                    }
                }

                // Remove element if it doesn't contain force-include tags
                if (!shouldKeep) {
                    $element.remove();
                }
            });
        }

        // Remove comments
        $clone('*').contents().filter(function (this: any) {
            return this.type === 'comment';
        }).remove();

        return $clone;
    }

    /**
     * Get the list of non-main content tags/selectors
     */
    static getNonMainTags(): string[] {
        return [...EXCLUDE_NON_MAIN_TAGS];
    }

    /**
     * Check if a selector is considered non-main content
     */
    static isNonMainTag(selector: string): boolean {
        return EXCLUDE_NON_MAIN_TAGS.includes(selector);
    }

    /**
     * Transform relative URLs to absolute URLs
     * Optimized with parallel processing for better performance
     */
    private async transformRelativeUrls($: any, baseUrl: string): Promise<void> {
        try {
            const base = new URL(baseUrl);

            // Execute all transformations in parallel
            await Promise.all([
                this.transformImageSrcsetAsync($, base),
                this.transformImageSrcAsync($, base),
                this.transformAnchorHrefAsync($, base)
            ]);

        } catch (error) {
            console.warn(`Failed to parse base URL: ${baseUrl}`, error);
        }
    }

    /**
     * Transform img srcset attributes (async version)
     * Handles complex srcset syntax with pixel density and width descriptors
     */
    private async transformImageSrcsetAsync($: any, baseUrl: URL): Promise<void> {
        return new Promise<void>((resolve) => {
            $('img[srcset]').each((_: number, element: any) => {
                const $img = $(element);
                const srcset = $img.attr('srcset');
                if (!srcset) return;

                try {
                    // Parse srcset entries
                    const sources: ImageSource[] = [];
                    const entries = srcset.split(',').map((entry: string) => entry.trim());

                    for (const entry of entries) {
                        const parts = entry.split(/\s+/);
                        if (parts.length === 0) continue;

                        const url = parts[0];
                        const descriptor = parts.length > 1 ? parts[1] : '1x';

                        let size = 1;
                        let isPixelDensity = true;

                        if (descriptor.endsWith('x')) {
                            // Pixel density descriptor (e.g., "2x")
                            const parsedSize = parseFloat(descriptor.slice(0, -1));
                            if (!isNaN(parsedSize)) {
                                size = parsedSize;
                                isPixelDensity = true;
                            }
                        } else if (descriptor.endsWith('w')) {
                            // Width descriptor (e.g., "800w")
                            const parsedSize = parseInt(descriptor.slice(0, -1));
                            if (!isNaN(parsedSize)) {
                                size = parsedSize;
                                isPixelDensity = false;
                            }
                        }

                        sources.push({
                            url: this.resolveUrl(baseUrl, url),
                            size,
                            isPixelDensity
                        });
                    }

                    // If all sources are pixel density descriptors, add the src attribute as 1x if it exists
                    if (sources.every(s => s.isPixelDensity)) {
                        const src = $img.attr('src');
                        if (src) {
                            sources.push({
                                url: this.resolveUrl(baseUrl, src),
                                size: 1,
                                isPixelDensity: true
                            });
                        }
                    }

                    // Sort by size (descending) and use the largest as src
                    sources.sort((a, b) => b.size - a.size);
                    if (sources.length > 0 && sources[0]) {
                        $img.attr('src', sources[0].url);
                    }

                    // Rebuild srcset with absolute URLs
                    const newSrcset = entries.map((entry: string) => {
                        const parts = entry.split(/\s+/);
                        if (parts.length === 0) return entry;

                        const url = parts[0];
                        if (!url) return entry;

                        const absoluteUrl = this.resolveUrl(baseUrl, url);
                        return parts.length > 1 ? `${absoluteUrl} ${parts[1]}` : absoluteUrl;
                    }).join(', ');

                    $img.attr('srcset', newSrcset);

                } catch (error) {
                    console.warn(`Failed to transform srcset for image: ${srcset}`, error);
                }
            });
            resolve();
        });
    }

    /**
     * Transform img src attributes (async version)
     */
    private async transformImageSrcAsync($: any, baseUrl: URL): Promise<void> {
        return new Promise<void>((resolve) => {
            $('img[src]').each((_: number, element: any) => {
                const $img = $(element);
                const src = $img.attr('src');
                if (src) {
                    try {
                        const absoluteUrl = this.resolveUrl(baseUrl, src);
                        $img.attr('src', absoluteUrl);
                    } catch (error) {
                        console.warn(`Failed to transform src for image: ${src}`, error);
                    }
                }
            });
            resolve();
        });
    }

    /**
     * Transform anchor href attributes (async version)
     */
    private async transformAnchorHrefAsync($: any, baseUrl: URL): Promise<void> {
        return new Promise<void>((resolve) => {
            $('a[href]').each((_: number, element: any) => {
                const $anchor = $(element);
                const href = $anchor.attr('href');
                if (href) {
                    try {
                        const absoluteUrl = this.resolveUrl(baseUrl, href);
                        $anchor.attr('href', absoluteUrl);
                    } catch (error) {
                        console.warn(`Failed to transform href for anchor: ${href}`, error);
                    }
                }
            });
            resolve();
        });
    }

    /**
     * Resolve relative URL to absolute URL
     * Handles malformed URLs similar to Firecrawl's implementation
     */
    private resolveUrl(baseUrl: URL, relativeUrl: string): string {
        try {
            // Handle malformed URLs like "http:/example.com" -> "http://example.com"
            let fixedUrl = relativeUrl;
            if (fixedUrl.startsWith('http:/') && !fixedUrl.startsWith('http://')) {
                fixedUrl = `http://${fixedUrl.slice(6)}`;
            } else if (fixedUrl.startsWith('https:/') && !fixedUrl.startsWith('https://')) {
                fixedUrl = `https://${fixedUrl.slice(7)}`;
            }

            // Use URL constructor to resolve relative URLs
            const resolved = new URL(fixedUrl, baseUrl);
            return resolved.toString();
        } catch (error) {
            // If URL resolution fails, return the original URL
            console.warn(`Failed to resolve URL: ${relativeUrl} with base: ${baseUrl.toString()}`, error);
            return relativeUrl;
        }
    }
}
