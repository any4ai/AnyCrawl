import { extractUrlsFromCheerio } from "crawlee";
import { log } from "@anycrawl/libs";
import { QueueManager } from "../managers/Queue.js";
import { resolveAutoEngine } from "./autoEngine.js";
import { completedJob, failedJob } from "@anycrawl/db";
import { minimatch } from "minimatch";
import * as cheerio from "cheerio";

interface PendingPage {
    url: string;
    depth: number;
}

export async function runAutoCrawl(
    jobId: string,
    payload: any,
): Promise<void> {
    const seedUrl: string = payload.url;
    const opts = payload.crawl_options || {};
    const limit: number = opts.limit || 10;
    const maxDepth: number = opts.max_depth || 10;
    const strategy: string = opts.strategy || "same-domain";
    const includePaths: string[] = opts.include_paths || [];
    const excludePaths: string[] = opts.exclude_paths || [];

    const visited = new Set<string>();
    const pending: PendingPage[] = [{ url: seedUrl, depth: 0 }];
    let completed = 0;
    let failed = 0;

    try {
        while (pending.length > 0 && completed + failed < limit) {
            const batchSize = Math.min(
                5,
                limit - completed - failed,
                pending.length,
            );
            const batch = pending.splice(0, batchSize);

            const results = await Promise.allSettled(
                batch.map(async (page) => {
                    if (visited.has(page.url)) return null;
                    visited.add(page.url);

                    const engine =
                        payload.engine === "auto"
                            ? await resolveAutoEngine(
                                  page.url,
                                  payload.options?.proxy,
                              )
                            : payload.engine;
                    const queueName = `scrape-${engine}`;

                    const scrapeId =
                        await QueueManager.getInstance().addJob(queueName, {
                            ...payload,
                            url: page.url,
                            engine,
                            options: {
                                ...payload.options,
                                formats: [
                                    ...new Set([
                                        ...(payload.options?.formats || [
                                            "markdown",
                                        ]),
                                        "links",
                                    ]),
                                ],
                            },
                            parentId: jobId,
                            type: "crawl",
                            queueName,
                        });

                    const result =
                        await QueueManager.getInstance().waitJobDone(
                            queueName,
                            scrapeId,
                            payload.options?.timeout || 60000,
                        );
                    if (!result || result.status === "failed") {
                        failed++;
                        return null;
                    }
                    completed++;

                    let links: string[] = result.links || [];
                    if (
                        links.length === 0 &&
                        (result.rawHtml || result.html)
                    ) {
                        const $ = cheerio.load(result.rawHtml || result.html);
                        links = extractUrlsFromCheerio(
                            $ as any,
                            "a[href]",
                            page.url,
                        );
                    }
                    return { links, depth: page.depth };
                }),
            );

            for (const r of results) {
                if (r.status !== "fulfilled" || !r.value) continue;
                const { links, depth } = r.value;
                if (depth >= maxDepth) continue;
                for (const link of links) {
                    if (
                        visited.has(link) ||
                        completed + failed + pending.length >= limit
                    )
                        continue;
                    if (!matchesStrategy(link, seedUrl, strategy)) continue;
                    if (!matchesPaths(link, includePaths, excludePaths))
                        continue;
                    pending.push({ url: link, depth: depth + 1 });
                }
            }
        }

        await completedJob(jobId, true, {
            total: completed + failed,
            completed,
            failed,
        });
    } catch (err) {
        const msg =
            err instanceof Error ? err.message : "Crawl coordinator failed";
        log.error(`[CrawlCoordinator] ${jobId} failed: ${msg}`);
        await failedJob(jobId, msg, false, {
            total: completed + failed,
            completed,
            failed,
        });
    }
}

function matchesStrategy(
    url: string,
    seedUrl: string,
    strategy: string,
): boolean {
    try {
        const seedHost = new URL(seedUrl).hostname;
        const urlHost = new URL(url).hostname;
        if (strategy === "same-domain") return urlHost === seedHost;
        if (strategy === "same-origin")
            return new URL(url).origin === new URL(seedUrl).origin;
        return true;
    } catch {
        return false;
    }
}

function matchesPaths(
    url: string,
    include: string[],
    exclude: string[],
): boolean {
    if (
        exclude.length > 0 &&
        exclude.some((p) => minimatch(url, p, { dot: true }))
    )
        return false;
    if (include.length > 0)
        return include.some((p) => minimatch(url, p, { dot: true }));
    return true;
}
