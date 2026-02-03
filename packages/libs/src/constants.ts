/**
 * Ad domains
 */
export const AD_DOMAINS = [
    'doubleclick.net',
    'adservice.google.com',
    'googlesyndication.com',
    'googletagservices.com',
    'googletagmanager.com',
    'google-analytics.com',
    'adsystem.com',
    'adservice.com',
    'adnxs.com',
    'ads-twitter.com',
    'facebook.net',
    'fbcdn.net',
    'amazon-adsystem.com'
]

export const ALLOWED_ENGINES = ["playwright", "cheerio", "puppeteer"] as const;

export const SCRAPE_FORMATS = [
    "markdown",
    "html",
    "text",
    "screenshot",
    "screenshot@fullPage",
    "rawHtml",
    "json",
    "summary",
] as const;

export const EXTRACT_SOURCES = [
    "html",
    "markdown",
] as const;

// Job type constants (avoid importing BaseEngine early)
export const JOB_TYPE_SCRAPE = 'scrape' as const;
export const JOB_TYPE_CRAWL = 'crawl' as const;

export const AVAILABLE_SEARCH_ENGINES = ["google", "searxng", 'ac-engine'] as const;
