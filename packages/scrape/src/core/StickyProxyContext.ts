import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { NonRetryableError } from "crawlee";
import { config } from "@anycrawl/libs";

export const STICKY_SESSION_TOKEN = "{sessionId}";
export const stickyProxySelection = new AsyncLocalStorage<boolean>();

export class StickyProxyConfigurationError extends NonRetryableError {}

export function proxyConfigurationId(url: string): string {
    return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** Never include credentials or the input URL in configuration errors. */
export function validateStickyProxyTemplate(template: string, ttlSecs: number): void {
    const fail = (reason: string): never => {
        throw new StickyProxyConfigurationError(`Sticky proxy ${proxyConfigurationId(template)}: ${reason}`);
    };
    if (template.split(STICKY_SESSION_TOKEN).length !== 2) {
        fail("exactly one {sessionId} placeholder is required");
    }
    let url: URL;
    let username: string;
    try {
        url = new URL(template);
        username = decodeURIComponent(url.username);
        decodeURIComponent(url.password);
    }
    catch { return fail("invalid proxy URL"); }
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) fail("unsupported proxy protocol");
    if (!url.hostname || url.hash || url.search || (url.pathname && url.pathname !== "/")) fail("invalid proxy endpoint");
    // Session substitution must not change the network endpoint.
    if (!username.includes(STICKY_SESSION_TOKEN)) {
        fail("place {sessionId} in the proxy username");
    }
    if (/[{}]/.test(template.replace(STICKY_SESSION_TOKEN, ""))) fail("unknown placeholder");
    if (url.hostname === "eu-isp.flashproxy.io") {
        const minutes = /-time-(\d+)-session-/.exec(username)?.[1];
        if (!minutes || ttlSecs > Number(minutes) * 60) fail("declared sticky window exceeds the provider time parameter");
    }
}

export function rejectUnexpandedProxy(url: string): void {
    if (url.includes(STICKY_SESSION_TOKEN) || /%7bsessionId%7d/i.test(url)) {
        throw new StickyProxyConfigurationError(`Proxy ${proxyConfigurationId(url)}: enable sticky management before using a session template`);
    }
}

export function proxyForCache(context: any): string | undefined {
    return context?.proxyInfo?.stickyProxyTemplate ?? context?.proxyInfo?.url;
}

/** HTTP/Cheerio share the proxy list, but have no browser lifetime to manage. */
export function materializeHttpProxy(url: string): string {
    if (url.includes(STICKY_SESSION_TOKEN) && config.proxy.stickyEnabled) {
        validateStickyProxyTemplate(url, config.proxy.stickyTtlSecs!);
        return url.replace(STICKY_SESSION_TOKEN, randomBytes(8).toString("hex"));
    }
    rejectUnexpandedProxy(url);
    return url;
}
