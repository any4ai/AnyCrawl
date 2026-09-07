import { config } from "@anycrawl/libs";

/** Shared by the application factories and the live browser-score application variant. */
export function getBrowserLaunchOptions(): Record<string, unknown> {
    const timezone = config.engine.browserTimezone;
    const locale = config.engine.browserLocale;
    if (timezone) {
        try {
            new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
        } catch {
            throw new Error("ANYCRAWL_BROWSER_TIMEZONE must be a valid IANA timezone.");
        }
    }
    if (locale) {
        try {
            Intl.getCanonicalLocales(locale);
        } catch {
            throw new Error("ANYCRAWL_BROWSER_LOCALE must be a valid language tag.");
        }
    }
    const args = [
        ...(process.platform === "linux"
            ? [
                  "--no-sandbox",
                  "--disable-setuid-sandbox",
                  "--disable-dev-shm-usage",
                  "--no-zygote",
                  "--disable-gpu",
              ]
            : []),
        "--no-first-run",
        "--disable-accelerated-2d-canvas",
        ...(config.engine.lightMode
            ? [
                  "--disable-background-networking",
                  "--disable-breakpad",
                  "--disable-component-extensions-with-background-pages",
                  "--disable-default-apps",
                  "--disable-extensions",
                  "--disable-features=TranslateUI",
                  "--disable-hang-monitor",
                  "--disable-popup-blocking",
                  "--disable-prompt-on-repost",
                  "--disable-sync",
                  "--metrics-recording-only",
                  "--password-store=basic",
                  "--use-mock-keychain",
                  "--mute-audio",
                  "--force-color-profile=srgb",
              ]
            : []),
        ...(config.engine.ignoreSSLError
            ? ["--ignore-certificate-errors", "--ignore-certificate-errors-spki-list"]
            : []),
    ];
    return {
        args,
        headless: config.engine.headless,
        ignoreHTTPSErrors: config.engine.ignoreSSLError,
        ...(config.engine.userAgent ? { userAgent: config.engine.userAgent } : {}),
        ...(timezone ? { timezone } : {}),
        ...(locale ? { locale } : {}),
    };
}

/** Resolve only when needed; explicit region configuration avoids an extra lookup. */
export function shouldResolveBrowserGeoip(
    options: Record<string, unknown>,
    proxyPresent: boolean
): boolean {
    if (typeof options.geoip === "boolean") return options.geoip;
    const args = Array.isArray(options.args) ? (options.args as string[]) : [];
    const timezone =
        options.timezone ??
        options.timezoneId ??
        args.find((arg) => arg.startsWith("--fingerprint-timezone="));
    const locale =
        options.locale ??
        args.find((arg) => arg.startsWith("--fingerprint-locale=") || arg.startsWith("--lang="));
    return config.engine.browserGeoip && proxyPresent && !(timezone && locale);
}
