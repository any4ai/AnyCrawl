import { DomainCache } from "./DomainCache.js";
import { log } from "@anycrawl/libs";

const cache = new DomainCache<{ avgMs: number; samples: number }>("ac:swait");

export interface SmartWaitOptions {
    maxWaitMs?: number;
    stableMs?: number;
    useCache?: boolean;
    label?: string;
}

export async function smartWaitForDOMStable(
    page: any,
    url: string,
    opts: SmartWaitOptions = {},
): Promise<void> {
    const {
        maxWaitMs = 5000,
        stableMs = 300,
        useCache = true,
        label = "smartWait",
    } = opts;
    if (!page || page.isClosed?.()) return;

    let domain: string;
    try {
        domain = new URL(url).hostname;
    } catch {
        return;
    }

    if (useCache) {
        const c = await cache.get(domain);
        if (c) {
            const t = Math.min(Math.ceil(c.avgMs * 1.2), maxWaitMs);
            if (t > 50) {
                log.debug(`[${label}] cached wait ${t}ms for ${domain}`);
                await new Promise((r) => setTimeout(r, t));
            }
            return;
        }
    }

    const start = Date.now();
    try {
        await page.evaluate(
            ({ maxWaitMs, stableMs }: { maxWaitMs: number; stableMs: number }) =>
                new Promise<void>((resolve) => {
                    const target = document.body || document.documentElement;
                    if (!target) {
                        resolve();
                        return;
                    }
                    let st: ReturnType<typeof setTimeout> | null = null;
                    let mt: ReturnType<typeof setTimeout> | null = null;
                    const done = () => {
                        ob.disconnect();
                        if (st) clearTimeout(st);
                        if (mt) clearTimeout(mt);
                        resolve();
                    };
                    const ob = new MutationObserver(() => {
                        if (st) clearTimeout(st);
                        st = setTimeout(done, stableMs);
                    });
                    ob.observe(target, {
                        childList: true,
                        subtree: true,
                        characterData: true,
                    });
                    st = setTimeout(done, stableMs);
                    mt = setTimeout(done, maxWaitMs);
                }),
            { maxWaitMs, stableMs },
        );
    } catch {
        // page closed or navigated during evaluate
    }

    const actual = Date.now() - start;
    log.debug(`[${label}] DOM stable after ${actual}ms for ${domain}`);

    if (useCache) {
        const prev = await cache.get(domain);
        const samples = Math.min((prev?.samples || 0) + 1, 50);
        const alpha = 2 / (samples + 1);
        const avgMs = prev
            ? alpha * actual + (1 - alpha) * prev.avgMs
            : actual;
        cache.set(domain, { avgMs, samples }).catch(() => {});
    }
}
