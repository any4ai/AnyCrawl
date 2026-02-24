import { z } from "zod";
import { SearchLocale } from "../data/Locale.js";
import { AVAILABLE_SEARCH_ENGINES } from "../constants.js";
import { baseSchema } from "./BaseSchema.js";

const scrapeOptionsInputSchema = baseSchema
    .pick({
        engine: true,
        proxy: true,
        formats: true,
        timeout: true,
        wait_until: true,
        wait_for: true,
        wait_for_selector: true,
        include_tags: true,
        exclude_tags: true,
        json_options: true,
        extract_source: true,
        ocr_options: true,
        max_age: true,
        store_in_cache: true,
    })
    .strict();

const searchSchema = z.object({
    template_id: z.string().optional(),
    variables: z.record(z.any()).optional(),
    engine: z.enum(AVAILABLE_SEARCH_ENGINES).optional(),
    query: z.string(),
    limit: z.number().max(100).min(1).default(10),
    offset: z.number().min(0).default(0),
    pages: z.number().min(1).max(20).optional(),
    lang: z.custom<SearchLocale>().optional(),
    country: z.custom<SearchLocale>().optional(),
    timeRange: z.enum(["day", "week", "month", "year"]).optional(),
    sources: z.enum(["web", "images", "news"]).optional(), // Search sources (SearXNG)
    scrape_options: scrapeOptionsInputSchema.optional(),
    safe_search: z.number().min(0).max(2).nullable().optional(), // 0: off, 1: medium, 2: high, null: default (Google only)
});
export const TemplateSearchSchema = searchSchema.pick({
    engine: true,
    query: true,
    limit: true,
    offset: true,
    pages: true,
    lang: true,
    country: true,
    timeRange: true,
    sources: true,
    scrape_options: true,
    safe_search: true
});
export type TemplateSearchSchema = z.infer<typeof TemplateSearchSchema>;
export type SearchSchema = z.infer<typeof searchSchema>;
export { searchSchema };
