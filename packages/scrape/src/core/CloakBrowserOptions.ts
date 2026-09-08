type Options = Record<string, any>;

const wrapperKeys = new Set([
    "headless",
    "proxy",
    "extensionPaths",
    "stealthArgs",
    "timezone",
    "timezoneId",
    "locale",
    "geoip",
    "licenseKey",
    "browserVersion",
    "releaseChannel",
    "humanize",
    "humanPreset",
    "humanConfig",
]);
const contextKeys = new Set([
    "acceptDownloads",
    "baseURL",
    "bypassCSP",
    "colorScheme",
    "contrast",
    "deviceScaleFactor",
    "extraHTTPHeaders",
    "forcedColors",
    "geolocation",
    "hasTouch",
    "httpCredentials",
    "ignoreHTTPSErrors",
    "isMobile",
    "javaScriptEnabled",
    "offline",
    "permissions",
    "recordHar",
    "recordVideo",
    "reducedMotion",
    "screen",
    "serviceWorkers",
    "storageState",
    "strictSelectors",
    "userAgent",
    "viewport",
    "clientCertificates",
]);

/** Convert Crawlee's flat driver options without losing native launch/context options. */
export function toCloakBrowserOptions(
    input: Options,
    engine: "playwright" | "puppeteer",
    persistent = false
): Options {
    const {
        launchOptions = {},
        contextOptions = {},
        args,
        defaultViewport,
        __anycrawlNativeFingerprint,
        __anycrawlExplicitUserAgent,
        __anycrawlUserAgentArgs,
        __anycrawlTrackBrowser,
        ...flat
    } = input;
    const { args: nestedArgs, defaultViewport: nestedViewport, ...rawLaunch } = launchOptions;
    const explicitViewport = defaultViewport !== undefined ? defaultViewport : nestedViewport;
    const result: Options = { launchOptions: {} };
    const context: Options = { ...contextOptions };
    const combinedArgs = [...(nestedArgs ?? []), ...(args ?? [])] as string[];
    // Crawlee injects an old default UA after preLaunchHooks when fingerprints are disabled.
    // Only remove framework-added UA flags; explicit operator/caller overrides are preserved.
    const filteredArgs =
        __anycrawlNativeFingerprint && Array.isArray(__anycrawlUserAgentArgs)
            ? combinedArgs.filter(
                  (arg) => !arg.startsWith("--user-agent") || __anycrawlUserAgentArgs.includes(arg)
              )
            : __anycrawlNativeFingerprint && !__anycrawlExplicitUserAgent
              ? combinedArgs.filter((arg) => !arg.startsWith("--user-agent"))
              : combinedArgs;
    if (args !== undefined || nestedArgs !== undefined) result.args = [...new Set(filteredArgs)];
    for (const [key, value] of Object.entries({ ...rawLaunch, ...flat })) {
        if (value === undefined) continue;
        if (wrapperKeys.has(key)) result[key] = value;
        else if (key === "userDataDir" && persistent) result.userDataDir = value;
        else if (engine === "playwright" && contextKeys.has(key)) context[key] = value;
        else result.launchOptions[key] = value;
    }
    if (engine === "puppeteer" && __anycrawlNativeFingerprint) {
        // Crawlee appends its authenticated forwarding proxy after preLaunchHooks.
        // Use that transport for both CloakBrowser GeoIP and Chrome. Passing the
        // upstream again makes the wrapper append a second --proxy-server and
        // bypasses Crawlee's authentication in the default browser context.
        const proxyArgs = filteredArgs.filter((arg) => arg.startsWith("--proxy-server="));
        const transport = proxyArgs.at(-1)?.slice("--proxy-server=".length);
        if (transport) {
            result.proxy = transport;
            result.args = (result.args ?? []).filter((arg: string) => !arg.startsWith("--proxy-server="));
        }
    }
    if (engine === "playwright") {
        if (explicitViewport !== undefined && context.viewport === undefined)
            context.viewport = explicitViewport;
        // Locale/timezone must be native binary flags, never context CDP emulation.
        result.timezone = result.timezone ?? result.timezoneId ?? context.timezoneId;
        result.locale = result.locale ?? context.locale;
        delete result.timezoneId;
        delete context.timezoneId;
        delete context.locale;
        for (const key of ["viewport", "userAgent", "colorScheme"] as const) {
            if (context[key] !== undefined) {
                result[key] = context[key];
                delete context[key];
            }
        }
        if (Object.keys(context).length) result.contextOptions = context;
    } else if (explicitViewport !== undefined) {
        result.launchOptions.defaultViewport = explicitViewport;
    }
    if (Object.keys(result.launchOptions).length === 0) delete result.launchOptions;
    for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
    return result;
}
