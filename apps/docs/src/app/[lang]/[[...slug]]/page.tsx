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

    const page = source.getPage(params.slug);
    if (!page) notFound();

    const MDXContent = page.data.body;
    const slug = params.slug.join("/");
    const pageUrl = `${baseUrl}/${params.lang}/${slug}`;

    const jsonLd = {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: page.data.title,
        description: page.data.description,
        url: pageUrl,
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
        image: "https://api.anycrawl.dev/v1/public/storage/file/AnyCrawl.jpeg",
        inLanguage: params.lang === "zh-cn" ? "zh-Hans" : params.lang === "zh-tw" ? "zh-Hant" : "en",
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

export async function generateMetadata(props: {
    params: Promise<{ lang: string; slug?: string[] }>;
}) {
    const params = await props.params;
    const page = source.getPage(params.slug, params.lang);
    if (!page) notFound();

    const slug = params.slug ? params.slug.join("/") : "";
    const pageUrl = `${baseUrl}/${params.lang}${slug ? `/${slug}` : ""}`;
    const pageDescription = page.data.description || "";
    const description = pageDescription
        ? pageDescription.endsWith(".")
            ? `${pageDescription} Turning web into AI with AnyCrawl.`
            : `${pageDescription}. Turning web into AI with AnyCrawl.`
        : "Turning web into AI with AnyCrawl.";
    const ogImage = "https://api.anycrawl.dev/v1/public/storage/file/AnyCrawl.jpeg";

    return {
        title: `${page.data.title} - AnyCrawl Docs`,
        description,
        openGraph: {
            title: page.data.title,
            description: pageDescription || description,
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
            title: page.data.title,
            description: pageDescription || description,
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
