import { DomainCache } from "./DomainCache.js";
import { log } from "@anycrawl/libs";

const cache = new DomainCache<{ avgMs: number; samples: number }>("ac:ssready");

const DEFAULT_MAX_WAIT_MS = Number(process.env.ANYCRAWL_SCREENSHOT_MAX_WAIT_MS) || 8000;
const DEFAULT_STABLE_MS = Number(process.env.ANYCRAWL_SCREENSHOT_STABLE_MS) || 300;
const ALMOST_IDLE_THRESHOLD = 2;

export interface ScreenshotReadyOptions {
    maxWaitMs?: number;
    stableMs?: number;
    useCache?: boolean;
    fullPage?: boolean;
}

/**
 * Trigger lazy-loaded images by scrolling.
 * For viewport screenshots: one viewport-height scroll down and back (fast).
 * For fullPage screenshots: scroll the entire document to trigger all images.
 */
async function triggerLazyImages(page: any, fullPage: boolean): Promise<void> {
    try {
        await page.evaluate((scrollAll: boolean) => {
            const viewportH = window.innerHeight;
            if (scrollAll) {
                const docH = Math.max(
                    document.body.scrollHeight,
                    document.documentElement.scrollHeight,
                );
                const step = viewportH;
                let pos = 0;
                while (pos < docH) {
                    pos += step;
                    window.scrollTo(0, pos);
                }
            } else {
                window.scrollTo(0, viewportH);
            }
            window.scrollTo(0, 0);
        }, fullPage);
        await new Promise((r) => setTimeout(r, fullPage ? 200 : 100));
    } catch {
        // page closed during scroll
    }
}

// ---------------------------------------------------------------------------
// CDP-based network "almost idle" detection (Node.js side, event-driven)
// ---------------------------------------------------------------------------

/**
 * Track pending network requests via CDP Network.* events.
 * Uses "almost idle" semantics: resolves when <=ALMOST_IDLE_THRESHOLD
 * requests are in-flight for `stableMs`.
 *
 * SPAs like Reddit/Twitter never reach true 0-pending due to websockets,
 * analytics, and streaming responses. "Almost idle" is the practical signal.
 */
function waitForCDPNetworkAlmostIdle(
    cdp: any,
    stableMs: number,
    maxWaitMs: number,
): Promise<void> {
    return new Promise<void>((resolve) => {
        let pending = 0;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
            if (idleTimer) clearTimeout(idleTimer);
            if (maxTimer) clearTimeout(maxTimer);
            cdp.off("Network.requestWillBeSent", onRequest);
            cdp.off("Network.loadingFinished", onDone);
            cdp.off("Network.loadingFailed", onDone);
        };

        const checkIdle = () => {
            if (pending <= ALMOST_IDLE_THRESHOLD) {
                if (!idleTimer) {
                    idleTimer = setTimeout(() => { cleanup(); resolve(); }, stableMs);
                }
            } else if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };

        const onRequest = () => { pending++; checkIdle(); };
        const onDone = () => { pending = Math.max(0, pending - 1); checkIdle(); };

        cdp.on("Network.requestWillBeSent", onRequest);
        cdp.on("Network.loadingFinished", onDone);
        cdp.on("Network.loadingFailed", onDone);

        const maxTimer = setTimeout(() => { cleanup(); resolve(); }, maxWaitMs);

        checkIdle();
    });
}

// ---------------------------------------------------------------------------
// In-page readiness check (DOM stability + images + fonts, optional network)
// ---------------------------------------------------------------------------

/**
 * In-page check for visual readiness: image completeness, font loading,
 * DOM stability, and optionally in-page network idle.
 *
 * Resolution paths (fastest wins):
 *   - FAST: images + fonts ready → 200ms grace → resolve (skip DOM/net)
 *   - FULL: images + fonts + DOM stable (+ network idle) → resolve
 *   - TIMEOUT: maxWaitMs reached → resolve anyway
 *
 * Image check uses a **snapshot** of images taken at start so that SPAs
 * continuously adding new elements don't prevent resolution. Only images
 * with src/srcset that are at least partially in the viewport are tracked.
 * A >=80% completion threshold avoids blocking on a few broken images.
 */
async function waitForPageSignals(
    page: any,
    stableMs: number,
    maxWaitMs: number,
    withNetwork: boolean,
): Promise<string> {
    return await page.evaluate(
        (args: { stableMs: number; maxWaitMs: number; withNetwork: boolean }) =>
            new Promise<string>((resolve) => {
                const { stableMs, maxWaitMs, withNetwork } = args;
                const target = document.body || document.documentElement;
                if (!target) { resolve("no-target"); return; }

                let domStable = false;
                let networkIdle = !withNetwork;
                let imagesReady = false;
                let fontsReady = false;
                let resolved = false;

                let domTimer: ReturnType<typeof setTimeout> | null = null;
                let netTimer: ReturnType<typeof setTimeout> | null = null;
                let perfOb: PerformanceObserver | null = null;
                let imgLoaded = 0;
                let imgTotal = 0;

                const stateTag = () =>
                    `imgs=${imgLoaded}/${imgTotal},fonts=${fontsReady},dom=${domStable}`;

                const cleanup = () => {
                    if (domTimer) clearTimeout(domTimer);
                    if (netTimer) clearTimeout(netTimer);
                    if (maxTimer) clearTimeout(maxTimer);
                    if (fastTimer) clearTimeout(fastTimer);
                    if (fontSafetyTimer) clearTimeout(fontSafetyTimer);
                    mutOb.disconnect();
                    if (perfOb) try { perfOb.disconnect(); } catch {}
                    if (imgPoll) clearInterval(imgPoll);
                };

                const done = (r: string) => {
                    if (resolved) return;
                    resolved = true;
                    cleanup();
                    resolve(`${r}:${stateTag()}`);
                };

                const tryResolveFull = () => {
                    if (domStable && networkIdle && imagesReady && fontsReady) done("full");
                };

                const maxTimer = setTimeout(() => done("timeout"), maxWaitMs);

                let fastTimer: ReturnType<typeof setTimeout> | null = null;
                const tryFastResolve = () => {
                    if (imagesReady && fontsReady && !fastTimer && !resolved) {
                        fastTimer = setTimeout(() => done("fast"), 200);
                    }
                };

                // --- DOM stability ---
                const resetDom = () => {
                    if (domTimer) clearTimeout(domTimer);
                    domStable = false;
                    domTimer = setTimeout(() => { domStable = true; tryResolveFull(); }, stableMs);
                };
                const mutOb = new MutationObserver(resetDom);
                mutOb.observe(target, { childList: true, subtree: true, characterData: true });
                resetDom();

                // --- Network idle (in-page, only when requested) ---
                if (withNetwork) {
                    const resetNet = () => {
                        if (netTimer) clearTimeout(netTimer);
                        networkIdle = false;
                        netTimer = setTimeout(() => { networkIdle = true; tryResolveFull(); }, stableMs);
                    };
                    try {
                        perfOb = new PerformanceObserver(resetNet);
                        perfOb.observe({ type: "resource", buffered: false });
                    } catch { networkIdle = true; }
                    resetNet();
                }

                // --- Image completeness (snapshot-based, viewport only) ---
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const trackedImages = Array.from(document.querySelectorAll("img")).filter((img) => {
                    if (!img.src && !img.srcset) return false;
                    const r = img.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) return false;
                    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
                });
                imgTotal = trackedImages.length;

                const READY_THRESHOLD = 0.8;

                const checkImages = (): boolean => {
                    if (imgTotal === 0) return true;
                    imgLoaded = trackedImages.filter(
                        (img) => img.complete && (img.naturalWidth > 0 || !img.src),
                    ).length;
                    return imgLoaded / imgTotal >= READY_THRESHOLD;
                };

                let imgPoll: ReturnType<typeof setInterval> | null = null;
                imagesReady = checkImages();
                if (!imagesReady) {
                    imgPoll = setInterval(() => {
                        if (checkImages()) {
                            imagesReady = true;
                            if (imgPoll) clearInterval(imgPoll);
                            tryFastResolve();
                            tryResolveFull();
                        }
                    }, 120);
                }

                // --- Font readiness (with safety timeout) ---
                const FONT_SAFETY_MS = 1000;
                let fontSafetyTimer: ReturnType<typeof setTimeout> | null = null;
                if (typeof document.fonts?.ready?.then === "function") {
                    document.fonts.ready.then(() => {
                        fontsReady = true;
                        if (fontSafetyTimer) clearTimeout(fontSafetyTimer);
                        tryFastResolve();
                        tryResolveFull();
                    });
                    fontSafetyTimer = setTimeout(() => {
                        if (!fontsReady) {
                            fontsReady = true;
                            tryFastResolve();
                            tryResolveFull();
                        }
                    }, FONT_SAFETY_MS);
                } else {
                    fontsReady = true;
                }

                tryFastResolve();
                tryResolveFull();
            }),
        { stableMs, maxWaitMs, withNetwork },
    );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wait until the page is visually ready for a screenshot.
 *
 * Strategy:
 *   1. Scroll down/up to trigger lazy-loaded images.
 *   2. If CDP session available: run CDP network "almost idle" detection
 *      AND in-page visual readiness check IN PARALLEL via Promise.race.
 *      The in-page check can resolve early if images+fonts are ready
 *      (fast path) even if network never fully settles.
 *   3. Without CDP: pure in-page multi-signal check.
 *   4. Update domain cache with the actual wait time.
 */
export async function waitForScreenshotReady(
    page: any,
    url: string,
    opts: ScreenshotReadyOptions = {},
): Promise<void> {
    const {
        maxWaitMs = DEFAULT_MAX_WAIT_MS,
        stableMs = DEFAULT_STABLE_MS,
        useCache = true,
        fullPage = false,
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
        if (c && c.avgMs > 100) {
            log.debug(`[screenshotReady] cached hint ${Math.ceil(c.avgMs)}ms for ${domain}`);
        }
    }

    const start = Date.now();
    const cdp = (page as any).__anycrawlCdpSession;

    try {
        await triggerLazyImages(page, fullPage);

        const elapsed = Date.now() - start;
        const budget = Math.max(maxWaitMs - elapsed, 1000);

        let reason: string;
        if (cdp) {
            // CDP network tracking runs fire-and-forget; it self-cleans
            // on its own timeout.  The in-page visual check is the sole
            // gate -- it resolves as soon as images+fonts are ready
            // (fast path, ~200ms grace) regardless of network state.
            waitForCDPNetworkAlmostIdle(cdp, stableMs, budget).catch(() => {});
            reason = await waitForPageSignals(page, stableMs, budget, false);
        } else {
            reason = await waitForPageSignals(page, stableMs, budget, true);
        }
        log.debug(`[screenshotReady] resolved (${reason}) for ${domain}`);
    } catch {
        // page closed or navigated; proceed to screenshot anyway
    }

    const actual = Date.now() - start;
    log.debug(`[screenshotReady] ready after ${actual}ms for ${domain}`);

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
