import { createHash } from "crypto";
import { config } from "@anycrawl/libs";

/**
 * Dynamic fields that change on every scrape and must be excluded from content
 * comparison to avoid constant false-positive diffs.
 */
const VOLATILE_KEYS = new Set(["timestamp", "screenshot", "screenshot@fullPage"]);

/**
 * Remove volatile top-level keys from a scraped result data object before diffing.
 * Operates on the raw `job_results.data` jsonb value.
 */
function stripVolatileFields(data: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
        if (!VOLATILE_KEYS.has(k)) out[k] = v;
    }
    return out;
}

/**
 * Pick the best text representation of a scraped page for change-detection,
 * in priority order: markdown → text → (stripped) html → rawHtml.
 */
function pickContentField(data: Record<string, any>): string {
    if (typeof data.markdown === "string" && data.markdown.trim()) return data.markdown;
    if (typeof data.text === "string" && data.text.trim()) return data.text;
    if (typeof data.html === "string" && data.html.trim()) return data.html;
    if (typeof data.rawHtml === "string" && data.rawHtml.trim()) return data.rawHtml;
    return "";
}

/**
 * Apply diff_options.ignore_selectors by stripping matching CSS-selector-like
 * substrings from content. In text/markdown mode this is a best-effort removal
 * of lines that match the selector pattern verbatim — it is not a full HTML
 * DOM operation, which would require re-parsing. Full DOM removal is out of
 * scope for the MVP text diff path.
 */
function applyIgnoreSelectors(content: string, ignoreSelectors: string[]): string {
    if (!ignoreSelectors || ignoreSelectors.length === 0) return content;
    // Drop lines that contain any of the ignore patterns
    const lines = content.split("\n");
    const filtered = lines.filter(
        (line) => !ignoreSelectors.some((sel) => line.includes(sel))
    );
    return filtered.join("\n");
}

/**
 * Collapse multiple blank lines into one and trim leading/trailing whitespace
 * so that cosmetic whitespace changes don't count as diffs.
 */
function normalizeWhitespace(text: string): string {
    return text.replace(/\n{3,}/g, "\n\n").trim();
}

export interface NormalizeOptions {
    ignoreSelectors?: string[];
    onlyMainContent?: boolean;
}

/**
 * Produce the canonical text representation of a job result datum.
 * The returned string is suitable for hashing and line-level diffing.
 */
export function normalizeContent(
    data: Record<string, any>,
    opts: NormalizeOptions = {}
): string {
    const clean = stripVolatileFields(data);
    let content = pickContentField(clean);
    if (opts.ignoreSelectors) {
        content = applyIgnoreSelectors(content, opts.ignoreSelectors);
    }
    return normalizeWhitespace(content);
}

/**
 * Compute a stable sha256 hex digest of normalized content.
 * Two identical pages always produce the same hash regardless of run order.
 */
export function hashContent(normalized: string): string {
    return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Truncate inline content to the configured maximum length (default 256 KB)
 * before storing in `monitor_snapshots.content`.
 */
export function truncateForStorage(content: string): string {
    const maxChars = config.monitor.maxInlineContentChars;
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + "\n…[truncated]";
}
