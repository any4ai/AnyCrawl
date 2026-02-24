import { locales } from "@anycrawl/libs";

/**
 * Base interface for all search results
 */
export interface BaseSearchResult {
    title: string;
    url: string;
    description?: string;
    source: string;
    category?: string;
}

/**
 * Web search result
 */
export interface WebSearchResult extends BaseSearchResult {
    category: "web";
}

/**
 * Image search result
 */
export interface ImageSearchResult extends BaseSearchResult {
    category: "images";
    imageUrl?: string;         // Full image URL
    imageWidth?: number;       // Image width in pixels
    imageHeight?: number;      // Image height in pixels
    position?: number;         // Position in search results
    thumbnail_src?: string;    // Thumbnail URL
    img_format?: string;       // Image format (jpeg, png, etc.)
    filesize?: string;         // File size (e.g., "245.76 KB")
}

/**
 * News search result
 */
export interface NewsSearchResult extends BaseSearchResult {
    category: "news";
    snippet?: string;          // News snippet/summary
    date?: string;             // Published date
    imageUrl?: string;         // News thumbnail image
}

/**
 * Union type for all search results
 */
export type SearchResult = WebSearchResult | ImageSearchResult | NewsSearchResult;

export interface SearchTask {
    url: string;
    headers: Record<string, string>;
    cookies: Record<string, string>;
    requireProxy?: boolean; // Whether this search request requires proxy (default: true)
}

export type SearchResultType = "web" | "images" | "news";

export type SearchLocale = (typeof locales)[number]["code"] | "all";

export interface SearchOptions {
    query: string;
    limit?: number;
    offset?: number;
    pages?: number;
    lang?: SearchLocale;
    country?: SearchLocale;
    sources?: SearchResultType; // For SearXNG: web (default), images, news
    safe_search?: number | null; // 0: off, 1: medium, 2: high, null: default (Google only)
    timeRange?: "day" | "week" | "month" | "year"; // Uniform time range support
    concurrent?: boolean; // Whether to fetch pages concurrently (default: false)
    [key: string]: any;
}

export interface SearchEngine {
    search(options: SearchOptions): Promise<SearchTask>;
    getName(): string;
    parse(html: string, request?: any): Promise<SearchResult[]>;
    /** Whether engine can accept arbitrary limit in one request */
    readonly supportsDirectLimit?: boolean;
}
