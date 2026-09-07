import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { STANDARDS, type Site, type Thresholds } from "./scoring.js";

export const VARIANTS = [
    "application",
    "native",
    "fixed-only",
    "inject-only",
    "injected-fixed",
] as const;
export type Variant = (typeof VARIANTS)[number];
export interface Config {
    sites: Site[];
    variants: Variant[];
    rounds: number;
    seed: number;
    headless: boolean;
    network: "configured" | "direct";
    proxyUrl?: string;
    timezone?: string;
    locale?: string;
    navigationTimeoutMs: number;
    resultTimeoutMs: number;
    output?: string;
    thresholds: Thresholds;
}
export function parseConfig(args: string[], env: NodeJS.ProcessEnv): Config {
    const { values } = parseArgs({
        args: args[0] === "--" ? args.slice(1) : args,
        options: {
            sites: { type: "string", default: Object.keys(STANDARDS).join(",") },
            variants: { type: "string", default: "native,injected-fixed" },
            rounds: { type: "string", default: "1" },
            seed: { type: "string", default: "42069" },
            network: { type: "string", default: "configured" },
            "proxy-env": { type: "string", default: "ANYCRAWL_PROXY_URL" },
            "proxy-index": { type: "string", default: "0" },
            headed: { type: "boolean" },
            headless: { type: "boolean" },
            timezone: { type: "string" },
            locale: { type: "string" },
            output: { type: "string" },
            "navigation-timeout-ms": { type: "string", default: "45000" },
            "result-timeout-ms": { type: "string", default: "45000" },
            "min-authenticity": { type: "string" },
            "max-stealth": { type: "string" },
            "min-recaptcha": { type: "string" },
            "require-webdriver": { type: "boolean" },
        },
    });
    const list = <T extends string>(value: string, allowed: readonly T[], name: string): T[] => {
        const items = value.split(",").map((item) => item.trim());
        if (
            items.length === 0 ||
            items.some((item) => !allowed.includes(item as T)) ||
            new Set(items).size !== items.length
        )
            throw new Error(`Invalid or duplicate ${name}. Allowed: ${allowed.join(",")}`);
        return items as T[];
    };
    const number = (
        value: string | undefined,
        name: string,
        min: number,
        max: number,
        integer = false
    ) => {
        if (value === undefined) return undefined;
        const n = Number(value);
        if (
            value.trim() === "" ||
            !Number.isFinite(n) ||
            n < min ||
            n > max ||
            (integer && !Number.isInteger(n))
        )
            throw new Error(
                `Invalid ${name}: expected ${integer ? "integer" : "number"} in [${min}, ${max}].`
            );
        return n;
    };
    if (values.headed && values.headless) throw new Error("Choose either --headed or --headless.");
    if (values.network !== "configured" && values.network !== "direct")
        throw new Error("Network must be configured or direct.");
    const sites = list(values.sites!, Object.keys(STANDARDS) as Site[], "sites");
    const thresholds: Thresholds = {
        minAuthenticity: number(values["min-authenticity"], "min-authenticity", 0, 100),
        maxStealth: number(values["max-stealth"], "max-stealth", 0, 100),
        minRecaptcha: number(values["min-recaptcha"], "min-recaptcha", 0, 1),
        requireWebdriver: values["require-webdriver"],
    };
    for (const [enabled, site] of [
        [thresholds.minAuthenticity !== undefined, "browserscan"],
        [thresholds.maxStealth !== undefined, "creepjs"],
        [thresholds.minRecaptcha !== undefined, "recaptcha"],
        [thresholds.requireWebdriver, "sannysoft"],
    ] as const) {
        if (enabled && !sites.includes(site))
            throw new Error(`A threshold was provided for unselected site ${site}.`);
    }
    let proxyUrl: string | undefined;
    if (values.network === "configured") {
        const candidates = (env[values["proxy-env"]!] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        const index = number(values["proxy-index"], "proxy-index", 0, 1000, true)!;
        proxyUrl = candidates[index];
        if (!proxyUrl)
            throw new Error(
                `Proxy entry missing in ${values["proxy-env"]}. Supply a configured proxy or explicitly select --network direct.`
            );
        try {
            const url = new URL(proxyUrl);
            if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol))
                throw new Error();
            decodeURIComponent(url.username);
            decodeURIComponent(url.password);
        } catch {
            throw new Error("Configured proxy must be a valid HTTP(S) or SOCKS5 URL.");
        }
    }
    if (values.timezone) {
        try {
            new Intl.DateTimeFormat("en", { timeZone: values.timezone }).format();
        } catch {
            throw new Error("Invalid IANA timezone.");
        }
    }
    if (values.locale) {
        try {
            Intl.getCanonicalLocales(values.locale);
        } catch {
            throw new Error("Invalid locale.");
        }
    }
    const rounds = number(values.rounds, "rounds", 1, 10, true)!;
    const seed = number(values.seed, "seed", 1, 99999 - rounds + 1, true)!;
    return {
        sites,
        variants: list(values.variants!, VARIANTS, "variants"),
        rounds,
        seed,
        network: values.network,
        proxyUrl,
        headless: values.headless
            ? true
            : values.headed
              ? false
              : env.ANYCRAWL_HEADLESS !== "false",
        timezone: values.timezone,
        locale: values.locale,
        output: values.output,
        thresholds,
        navigationTimeoutMs: number(
            values["navigation-timeout-ms"],
            "navigation-timeout-ms",
            1000,
            300000,
            true
        )!,
        resultTimeoutMs: number(
            values["result-timeout-ms"],
            "result-timeout-ms",
            1000,
            300000,
            true
        )!,
    };
}

export const identifier = (value: string): string =>
    createHash("sha256").update(value).digest("hex").slice(0, 12);
export function redactText(text: string, proxyUrl?: string, extraSecrets: string[] = []): string {
    let result = text
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@")
        .replace(/([?&]token=)[^&\s]+/g, "$1[redacted]");
    const secrets = [...extraSecrets];
    if (proxyUrl) {
        result = result.split(proxyUrl).join("[configured proxy]");
        const url = new URL(proxyUrl);
        secrets.push(
            url.username,
            url.password,
            decodeURIComponent(url.username),
            decodeURIComponent(url.password)
        );
    }
    for (const secret of secrets.filter(Boolean)) {
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        result = result.replace(
            new RegExp(secret.length < 4 ? `\\b${escaped}\\b` : escaped, "g"),
            "[redacted]"
        );
    }
    return result;
}
