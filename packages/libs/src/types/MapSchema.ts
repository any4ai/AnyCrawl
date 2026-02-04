import { z } from "zod";

/**
 * Map link item schema
 */
export const mapLinkSchema = z.object({
    url: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
});

export type MapLink = z.infer<typeof mapLinkSchema>;

/**
 * Map request schema
 */
export const mapSchema = z.object({
    /**
     * The URL to map
     */
    url: z.string().url(),

    /**
     * Maximum number of URLs to return
     */
    limit: z.number().min(1).max(50000).default(5000),

    /**
     * Include subdomain URLs
     */
    include_subdomains: z.boolean().default(false),

    /**
     * Skip sitemap parsing
     */
    ignore_sitemap: z.boolean().default(false),
}).strict();

export type MapSchema = z.infer<typeof mapSchema>;
