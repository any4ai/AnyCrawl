import type { MetadataRoute } from "next";
import { source } from "@/lib/source";
import { baseUrl } from "@/lib/utils";

const languages = ["en", "zh-cn", "zh-tw"] as const;

function toDate(value: unknown): Date {
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d;
    }
    return new Date();
}

function buildAlternates(path: string) {
    const languages: Record<string, string> = {
        en: `${baseUrl}/en${path}`,
        "zh-CN": `${baseUrl}/zh-cn${path}`,
        "zh-TW": `${baseUrl}/zh-tw${path}`,
    };
    return { languages };
}

export default function sitemap(): MetadataRoute.Sitemap {
    const entries: MetadataRoute.Sitemap = [];

    entries.push({
        url: `${baseUrl}/en/general`,
        lastModified: new Date(),
        changeFrequency: "weekly",
        priority: 1,
        alternates: buildAlternates("/general"),
    });

    let pages: ReturnType<typeof source.getPages>;
    try {
        pages = source.getPages();
    } catch {
        return entries;
    }

    for (const page of pages) {
        const slug = page.slugs.join("/");
        if (!slug) continue;

        const path = `/${slug}`;

        for (const lang of languages) {
            entries.push({
                url: `${baseUrl}/${lang}${path}`,
                lastModified: toDate((page.data as unknown as Record<string, unknown>).lastModified),
                changeFrequency: "weekly",
                priority: 0.8,
                alternates: buildAlternates(path),
            });
        }
    }

    return entries;
}
