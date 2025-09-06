import { SearchEngine, SearchOptions, SearchResult, SearchTask } from "./types.js";
import { google } from "../data/Google.js";
import { log } from "@anycrawl/libs/log";
import * as cheerio from "cheerio";

export class GoogleSearchEngine implements SearchEngine {
    private baseUrl = "https://www.google.com/search";
    private readonly limit = 10;
    private readonly defaultHeaders = {
        Accept: "*/*",
    };

    private readonly defaultCookies = {
        CONSENT: "YES+",
    };

    // Time range mapping
    private readonly timeRangeMap: Record<string, string> = {
        day: "d",
        week: "w",
        month: "m",
        year: "y",
    };

    // Safe search mapping
    private readonly safeSearchMap: Record<number, string> = {
        0: "off",
        1: "medium",
        2: "high",
    };

    // Countries to skip
    private readonly skipCountries = [
        "AL", // Albania (sq)
        "AZ", // Azerbaijan (az)
        "BD", // Bangladesh (bn)
        "BN", // Brunei (ms)
        "BT", // Bhutan (dz)
        "ET", // Ethiopia (am)
        "GE", // Georgia (ka, os)
        "GL", // Greenland (kl)
        "KH", // Cambodia (km)
        "LA", // Laos (lo)
        "LK", // Sri Lanka (si, ta)
        "ME", // Montenegro (sr)
        "MK", // North Macedonia (mk, sq)
        "MM", // Myanmar (my)
        "MN", // Mongolia (mn)
        "MV", // Maldives (dv)
        "MY", // Malaysia (ms)
        "NP", // Nepal (ne)
        "TJ", // Tajikistan (tg)
        "TM", // Turkmenistan (tk)
        "UZ", // Uzbekistan (uz)
    ];

    constructor() { }

    getName(): string {
        return "Google";
    }

    /**
     * Build the search URL for Google
     * @param query - The search query
     * @param start - The starting index of the search results
     * @param options - Additional search options
     * @returns The search URL
     */
    private buildSearchUrl(query: string, start: number, options: SearchOptions): string {
        /**
         * The URL parameters used in Google search:
         * - hl: Interface language for the search UI (e.g. 'en' for English)
         * - lr: Restricts results to documents in specified language (e.g. 'lang_en' for English)
         * - cr: Restricts results to documents from specified country
         * - ie: Input encoding scheme for query string (utf8)
         * - oe: Output encoding scheme for results (utf8)
         */
        const eng_lang = google.languages[options.lang as keyof typeof google.languages] || "en";
        const lang_code = eng_lang.split("_")[1] || eng_lang;

        let country: string | undefined;

        if (options.lang && options.country) {
            // Skip if country is in skipCountries list
            if (!this.skipCountries.includes(options.country)) {
                // Prioritize lang-country
                const localeKey = `${options.lang}-${options.country}`;
                country = google.regions[localeKey as keyof typeof google.regions];
            }
        }

        if (!country && options.lang) {
            // if no country, find the first lang-country that's not in skipCountries
            const regionEntry = Object.entries(google.regions).find(([key, value]) => {
                const countryCode = value.toUpperCase();
                return (
                    key.startsWith(`${options.lang}-`) && !this.skipCountries.includes(countryCode)
                );
            });
            country = regionEntry ? regionEntry[1] : undefined;
        }

        if (!country) {
            country = "US";
        }

        const subdomain =
            google.custom.supported_domains[
            country.toUpperCase() as keyof typeof google.custom.supported_domains
            ] || "www.google.com";
        // Set the base URL using the appropriate subdomain
        this.baseUrl = `https://${subdomain}/search`;
        const params = new URLSearchParams({
            q: query,
            start: start.toString(),
            hl: `${lang_code}-${country}`,
            lr: eng_lang ?? "",
            cr: `country${country}`,
            ie: "utf8",
            oe: "utf8",
            filter: "0",
            asearch: "arc",
            async: this.generateAsyncParam(start),
        });

        // Respect per-page limit when provided (cap at 100 for Google)
        if (typeof options.limit === 'number' && options.limit > 0) {
            const perPage = Math.min(Math.max(options.limit, 1), 100);
            params.append("num", String(perPage));
        }

        // Add time range if specified
        if (options.timeRange && this.timeRangeMap[options.timeRange]) {
            params.append("tbs", `qdr:${this.timeRangeMap[options.timeRange]}`);
        }

        // Add safe search if specified
        if (options.safeSearch !== undefined && options.safeSearch !== null) {
            params.append("safe", this.safeSearchMap[options.safeSearch] || "medium");
        }

        return `${this.baseUrl}?${params.toString()}`;
    }

    /**
     * Generate the async parameter for the Google search URL
     * @param start - The starting index of the search results
     * @returns The async parameter string
     */
    private generateAsyncParam(start: number): string {
        // Simplified version of the Python ui_async function
        const arcId = `srp_${this.generateRandomString(23)}_1${start.toString().padStart(2, "0")}`;
        return `arc_id:${arcId},use_ac:true,_fmt:prog`;
    }

    /**
     * Generate a random string of a given length
     * @param length - The length of the random string
     * @returns The random string
     */
    private generateRandomString(length: number): string {
        const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
        return Array.from({ length }, () =>
            chars.charAt(Math.floor(Math.random() * chars.length))
        ).join("");
    }

    /**
     * Build the search tasks for Google
     * @param options - The search options of type SearchOptions
     * @returns The search tasks
     */
    async search(options: SearchOptions): Promise<SearchTask> {
        const { query, offset = 0, page = 1 } = options;
        try {
            const perPage = (typeof options.limit === 'number' && options.limit > 0)
                ? Math.min(Math.max(options.limit, 1), 100)
                : this.limit;
            const start = offset + (page - 1) * perPage;
            const url = this.buildSearchUrl(query, start, options);
            return {
                url: url,
                headers: this.defaultHeaders,
                cookies: this.defaultCookies,
            };
        } catch (error) {
            log.error(`Google search error: ${error}`);
            throw error;
        }
    }

    /**
     * Parse the search results from the Google search page
     * @param response - The response from the Google search page
     * @returns The search results
     */
    async parse(response: string, request: any): Promise<SearchResult[]> {
        const $ = cheerio.load(response);
        const results: SearchResult[] = [];

        // Parse regular search results
        $('div[jscontroller="SC7lYd"]').each((_, element) => {
            try {
                const $element = $(element);
                const $titleTag = $element.find("a h3").first();

                if (!$titleTag.length) {
                    return; // Skip if no title found
                }

                const title = $titleTag.text().trim();
                const url = $element.find("a h3").parent().attr("href") || "";

                if (!url) {
                    return; // Skip if no URL found
                }

                const $contentNodes = $element.find('div[data-sncf="1"]');
                $contentNodes.find("script").remove(); // Remove script elements
                const content = $contentNodes.text().trim();

                if (!content) {
                    return; // Skip if no content found
                }

                results.push({
                    title,
                    url,
                    description: content,
                    source: "Google Search Result",
                });
            } catch (error) {
                log.error("Error parsing search result:", { error: String(error) });
            }
        });

        // // Parse suggestions using the specific XPath selector
        // $("div.EIaa9b a").each((_, element) => {
        //     const $element = $(element);
        //     const text = $element.find(".dg6jd").text().trim();

        //     if (text) {
        //         results.push({
        //             title: text,
        //             source: "Google Suggestions",
        //         });
        //     }
        // });

        return results;
    }
}
