export type CloudflarePageKind =
    | "content"
    | "widget"
    | "challenge"
    | "blocked"
    | "rate_limited"
    | "http_error"
    | "unknown";

export interface CloudflareDocument {
    url: string;
    ready: boolean;
    hasContent: boolean;
    widget: boolean;
    challengeForm: boolean;
    challengeRuntime: boolean;
    challengeTitle: boolean;
    challengeText: boolean;
}

export interface MainDocumentResponse {
    url: string;
    status: number;
    challenge: boolean;
}

export interface CloudflareDetection {
    kind: CloudflarePageKind;
    detected: boolean;
    ready: boolean;
    evidence: string[];
}

/** Runs in either Playwright or Puppeteer, with no injected page globals. */
export function readCloudflareDocument(): CloudflareDocument {
    const title = (document.title || "").toLowerCase();
    const text = (document.body?.innerText || "").trim();
    const lower = text.toLowerCase();
    return {
        url: location.href,
        ready: document.readyState !== "loading" && Boolean(document.body),
        hasContent:
            text.length > 0 ||
            Boolean(document.querySelector("main, article, img, canvas, video, form")),
        widget: Boolean(
            document.querySelector(
                '.cf-turnstile, input[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"]'
            )
        ),
        challengeForm: Boolean(
            document.querySelector(
                'form#challenge-form, form[action*="/cdn-cgi/challenge-platform/"]'
            )
        ),
        challengeRuntime: Boolean((window as any)._cf_chl_opt || (window as any).__cf_chl_opt),
        challengeTitle:
            /^(just a moment|checking your browser|performing security verification)([.!…\s]|$)/.test(
                title
            ),
        challengeText:
            /enable javascript and cookies to continue|performing security verification|security service to protect (itself|against)/.test(
                lower
            ),
    };
}

export function classifyCloudflareDocument(
    document: CloudflareDocument | null,
    response?: MainDocumentResponse
): CloudflareDetection {
    const documentKey = (raw: string) => {
        try {
            const url = new URL(raw);
            url.hash = "";
            // CF rewrites the address bar without replacing the main document/response.
            for (const key of [...url.searchParams.keys()])
                if (key.startsWith("__cf_chl_")) url.searchParams.delete(key);
            url.searchParams.sort();
            return url.href;
        } catch { return raw.split("#")[0]; }
    };
    // Response belongs to the current main document, never an iframe/subresource.
    const current =
        response && (!document || documentKey(response.url) === documentKey(document.url))
            ? response
            : undefined;
    const evidence: string[] = [];
    if (current?.challenge) evidence.push("cf-mitigated");
    if (
        document?.challengeForm &&
        (document.challengeRuntime || document.challengeTitle || document.challengeText)
    )
        evidence.push("challenge-form");
    if (document?.challengeRuntime && (document.challengeTitle || document.challengeText))
        evidence.push("challenge-runtime");
    if (document?.challengeTitle && document.challengeText) evidence.push("challenge-copy");
    let kind: CloudflarePageKind;
    if (evidence.length) kind = "challenge";
    else if (current?.status === 429) kind = "rate_limited";
    else if (current?.status === 401 || current?.status === 403) kind = "blocked";
    else if (current && current.status >= 400) kind = "http_error";
    else if (!document?.ready || !document.hasContent) kind = "unknown";
    else kind = document.widget ? "widget" : "content";
    return {
        kind,
        detected: kind === "challenge",
        ready: kind === "content" || kind === "widget",
        evidence,
    };
}

export async function inspectCloudflarePage(
    page: any,
    response?: MainDocumentResponse
): Promise<CloudflareDetection> {
    // A current main-document challenge header is authoritative. Do not repeatedly
    // execute DOM probes inside an active challenge merely to rediscover that fact.
    if (response?.challenge && typeof page?.url === 'function') {
        const key = (raw: string) => {
            try {
                const url = new URL(raw); url.hash = '';
                for (const name of [...url.searchParams.keys()]) if (name.startsWith('__cf_chl_')) url.searchParams.delete(name);
                url.searchParams.sort(); return url.href;
            } catch { return raw.split('#')[0]; }
        };
        if (key(response.url) === key(page.url()))
            return { kind: 'challenge', detected: true, ready: false, evidence: ['cf-mitigated'] };
    }
    let document: CloudflareDocument | null = null;
    if (page && !page.isClosed?.() && typeof page.evaluate === "function") {
        try {
            document = await page.evaluate(readCloudflareDocument);
        } catch {
            /* Navigation/closed execution contexts are unknown, never clearance. */
        }
    }
    return classifyCloudflareDocument(document, response);
}
