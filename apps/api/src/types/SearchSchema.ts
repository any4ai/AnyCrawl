import { z } from "zod";
import { SearchLocale } from "@anycrawl/search/engines/types";
import { AVAILABLE_SEARCH_ENGINES } from "@anycrawl/search/constants";
import { baseSchema } from "./BaseSchema.js";

const scrapeOptionsInputSchema = baseSchema
    .pick({
        engine: true,
        proxy: true,
        formats: true,
        timeout: true,
        wait_for: true,
        include_tags: true,
        exclude_tags: true,
        json_options: true,
    })
    .strict();

const searchSchema = z.object({
    engine: z.enum(AVAILABLE_SEARCH_ENGINES).optional(),
    query: z.string(),
    limit: z.number().max(100).min(1).default(10).optional(),
    offset: z.number().min(0).default(0).optional(),
    pages: z.number().min(1).max(20).optional(),
    lang: z.custom<SearchLocale>().optional(),
    country: z.custom<SearchLocale>().optional(),
    scrape_options: scrapeOptionsInputSchema.optional(),
    safeSearch: z.number().min(0).max(2).nullable().optional(), // 0: off, 1: medium, 2: high, null: default (Google only)
});

export type SearchSchema = z.infer<typeof searchSchema>;
export { searchSchema };
