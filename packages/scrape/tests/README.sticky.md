# Sticky browser recovery tests

Sticky remains opt-in through `ANYCRAWL_PROXY_STICKY_ENABLED` and
`ANYCRAWL_PROXY_STICKY_TTL_SECS`. Enabling requires proxy username templates
with exactly one `{sessionId}` and a provider session window covering the
configured TTL. The application does not change the provider's settings.

Healthy leases can be reused until their remaining safe lifetime cannot cover
the complete request budget. Resource failures may retire them earlier; target
origin failures exclude that origin. Content errors do not poison proxy health.
Sticky owns the browser identity instead of Crawlee's SessionPool; cookies stay
in their actual browser context. Context isolation remains separately configured.

Retries retain their original browser deadline and obey explicit proxy actions,
not retry count alone. Sticky success hints use a separate Redis namespace with
a 30-minute lifetime; individual session failures do not blacklist a template.

Run from `packages/scrape` using the same environment as the worker:

```sh
pnpm run test:sticky-lifecycle --engine=playwright
pnpm run test:sticky-lifecycle --engine=puppeteer
pnpm run test:sticky-recovery --engine=playwright
pnpm run test:sticky-recovery --engine=puppeteer
pnpm run test:sticky-cache
```

The lifecycle harness loads actual sticky, proxy, context and retirement
configuration. With sticky disabled it verifies the disabled path and reports
TTL coverage as `not_applicable`. With sticky enabled it observes the configured
TTL, checks the browser's exit IP periodically, and verifies natural retirement
plus a subsequent request on a new lease. It stops admitting observations when
the remaining safe lifetime cannot fit the complete request budget. It never
shortens TTL for the test. The default document is example.com; override it with
`ANYCRAWL_STICKY_E2E_URL`. Reports contain IP hashes rather than credentials.

An early retirement fails the **natural-expiry observation**, even if recovery
successfully returns the page. Preserve that result and distinguish it from a
recovery regression. The separate recovery harness injects explicit handler
errors while using real browser/proxy navigation: content timeout must retain
the healthy lease, while origin rotation and transport failure must recover
with another lease. The cache harness checks actual Redis Lua ordering in a
unique disposable namespace and deletes its test keys.

Both browser harnesses write JSON reports under `output/` and close their
browser, queue and process-local database/Redis connections. Keep reports,
credentials and `.env` files out of commits.

## Observed validation, 2026-09-09

On macOS with a provider-backed 7200-second sticky configuration, isolated
contexts and headed browsers:

- Puppeteer completed the two-hour observation: 22 successful samples on the
  original lease with unchanged sampled IP, TTL retirement after approximately
  7190 seconds (the 10-second guard), and a successful 23rd sample on a new lease.
- Playwright encountered `ERR_TUNNEL_CONNECTION_FAILED` during its IP probe at
  approximately 46 minutes. Replacement and retry succeeded, but the original
  lease did not complete the natural-expiry observation. This failure was retained.
- Both drivers passed the independent injected recovery scenarios. Redis
  namespace isolation, escalation evidence, expiry and atomic ordering passed.

These observations are not a guarantee of uninterrupted provider availability
or validation of a different deployment platform.
