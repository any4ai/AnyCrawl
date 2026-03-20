import { source } from "@/lib/source";
import { DocsPage, DocsBody, DocsDescription, DocsTitle } from "fumadocs-ui/page";
import { notFound, redirect } from "next/navigation";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { getMDXComponents } from "@/mdx-components";
import { baseUrl } from "@/lib/utils";

export default async function Page(props: { params: Promise<{ lang: string; slug?: string[] }> }) {
    const params = await props.params;

    // if there is no slug, redirect to the homepage
    if (!params.slug || params.slug.length === 0) {
        redirect(`/${params.lang}/general`);
    }

    const page = source.getPage(params.slug, params.lang);
    if (!page) notFound();

    const MDXContent = page.data.body;
    const slug = params.slug.join("/");
    const pageUrl = `${baseUrl}/${params.lang}/${slug}`;
    const langCodeMap: Record<string, string> = { "zh-cn": "zh-Hans", "zh-tw": "zh-Hant" };
    const langCode = langCodeMap[params.lang] ?? "en";

    const jsonLd = {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: page.data.title,
        description: page.data.description || "Turning web into AI with AnyCrawl.",
        url: pageUrl,
        datePublished: "2025-06-01",
        dateModified: new Date().toISOString().split("T")[0],
        author: {
            "@type": "Organization",
            name: "AnyCrawl",
            url: "https://anycrawl.dev",
        },
        publisher: {
            "@type": "Organization",
            name: "AnyCrawl",
            url: "https://anycrawl.dev",
            logo: {
                "@type": "ImageObject",
                url: "https://api.anycrawl.dev/v1/public/storage/file/AnyCrawl.jpeg",
            },
        },
        mainEntityOfPage: {
            "@type": "WebPage",
            "@id": pageUrl,
        },
        image: "https://api.anycrawl.dev/v1/public/storage/file/AnyCrawl.jpeg",
        inLanguage: langCode,
    };

    return (
        <>
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
            />
            <DocsPage toc={page.data.toc} full={page.data.full}>
                <DocsTitle>{page.data.title}</DocsTitle>
                <DocsDescription>{page.data.description}</DocsDescription>
                <DocsBody>
                    <MDXContent
                        components={getMDXComponents({
                            // this allows you to link to other pages with relative file paths
                            a: createRelativeLink(source, page),
                        })}
                    />
                </DocsBody>
            </DocsPage>
        </>
    );
}

export async function generateStaticParams() {
    return source.generateParams();
}

const apiDescriptions: Record<string, string> = {
    scraping: "AnyCrawl Scraping API reference — request/response schemas, parameters, and code examples for the POST /v1/scrape endpoint.",
    crawl: "AnyCrawl Crawl API reference — start asynchronous site crawl jobs with the POST /v1/crawl endpoint.",
    map: "AnyCrawl Map API reference — discover and extract all URLs from a website with the POST /v1/map endpoint.",
    search: "AnyCrawl Search API reference — query search engines and retrieve structured SERP results with the POST /v1/search endpoint.",
    health: "AnyCrawl Health Check API — verify API server status with the GET /health endpoint.",
};

function getDescription(title: string, explicitDesc: string | undefined, slug: string): string {
    if (explicitDesc) return explicitDesc;
    const lastSegment = slug.split("/").pop() || "";
    return apiDescriptions[lastSegment] || `${title} — AnyCrawl documentation.`;
}

export async function generateMetadata(props: {
    params: Promise<{ lang: string; slug?: string[] }>;
}) {
    const params = await props.params;
    const page = source.getPage(params.slug, params.lang);
    if (!page) notFound();

    const slug = params.slug ? params.slug.join("/") : "";
    const pageUrl = `${baseUrl}/${params.lang}${slug ? `/${slug}` : ""}`;
    const pageDescription = getDescription(page.data.title, page.data.description, slug);
    const description = pageDescription.endsWith(".")
        ? `${pageDescription} Turning web into AI with AnyCrawl.`
        : `${pageDescription}. Turning web into AI with AnyCrawl.`;
    const ogImage = "https://api.anycrawl.dev/v1/public/storage/file/AnyCrawl.jpeg";

    return {
        title: `${page.data.title} - AnyCrawl Docs`,
        description,
        openGraph: {
            title: `${page.data.title} - AnyCrawl`,
            description,
            type: "article",
            url: pageUrl,
            siteName: "AnyCrawl Docs",
            images: [
                {
                    url: ogImage,
                    width: 1200,
                    height: 630,
                    alt: `${page.data.title} - AnyCrawl`,
                },
            ],
        },
        twitter: {
            card: "summary_large_image",
            site: "@AnyCrawl",
            title: `${page.data.title} - AnyCrawl`,
            description,
            images: [ogImage],
        },
        alternates: {
            canonical: pageUrl,
            languages: {
                en: `${baseUrl}/en${slug ? `/${slug}` : ""}`,
                "zh-CN": `${baseUrl}/zh-cn${slug ? `/${slug}` : ""}`,
                "zh-TW": `${baseUrl}/zh-tw${slug ? `/${slug}` : ""}`,
            },
        },
    };
}
