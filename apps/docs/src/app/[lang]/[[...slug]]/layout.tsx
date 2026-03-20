import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { baseOptions } from "@/app/layout.config";
import { source } from "@/lib/source";

export default async function Layout({
    params,
    children,
}: Readonly<{
    params: Promise<{ lang: string }>;
    children: ReactNode;
}>) {
    const { lang } = await params;
    const tree = source.pageTree[lang] ?? source.pageTree["en"];

    return (
        <DocsLayout
            sidebar={{
                tabs: {
                    transform: (option) => ({
                        ...option,
                    }),
                },
            }}
            tree={tree}
            {...baseOptions}
        >
            {children}
        </DocsLayout>
    );
}
