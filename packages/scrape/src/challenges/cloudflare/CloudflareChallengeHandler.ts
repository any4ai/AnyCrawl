import { log } from "@anycrawl/libs";
import { resetChallengeState, ensureChallengeState, requestProxyAction } from "../ChallengeContext.js";
import { CDPTurnstileSolver } from "../../solvers/CDPTurnstileSolver.js";
import { TwoCaptchaTurnstileProvider } from "../../solvers/providers/TwoCaptchaTurnstileProvider.js";
import type { ChallengePlugin } from "../ChallengePlugin.js";

export class CloudflareChallengeHandler implements ChallengePlugin {
    public readonly name = "cloudflare";

    async onPreNavigation({ page, request, session }: any): Promise<void> {
        try {
            if (!page) return;
            const challengeState = resetChallengeState(request, "cloudflare");

            if (this.resolveProxyMode(request) !== "stealth") {
                return;
            }

            const requestUrl = (
                typeof request.url === "string" && request.url
                    ? request.url
                    : (request.loadedUrl || (typeof page.url === "function" ? page.url() : ""))
            );

            if (session && requestUrl) {
                try {
                    const cookies = await session.getCookies(requestUrl);
                    const cfClearance = cookies?.find((c: any) => c.key === "cf_clearance")?.value;
                    if (cfClearance) {
                        const parsedUrl = new URL(requestUrl);
                        await page.context().addCookies([{
                            name: "cf_clearance",
                            value: cfClearance,
                            domain: parsedUrl.hostname,
                            path: "/",
                            secure: parsedUrl.protocol === "https:",
                        }]);
                        log.info(`[CloudflareSolverHook] Injected stored cf_clearance cookie for ${requestUrl}`);
                    }
                } catch (cookieError) {
                    log.debug(`[CloudflareSolverHook] Cookie check skipped: ${cookieError instanceof Error ? cookieError.message : String(cookieError)}`);
                }
            }

            if ((page as any).__anycrawlCloudflareSolverSetup) return;

            const twoCaptchaKey = (process.env.ANYCRAWL_2CAPTCHA_API_KEY || "").trim();
            if (!twoCaptchaKey) {
                log.warning(`[CloudflareSolverHook] 2captcha unavailable for ${requestUrl || "unknown"}; missing ANYCRAWL_2CAPTCHA_API_KEY`);
                return;
            }

            const solveTimeoutMs = this.readEnvPositiveInt("ANYCRAWL_2CAPTCHA_TIMEOUT_MS", 60_000);
            const stealthTimeoutMs = this.readEnvPositiveInt("ANYCRAWL_STEALTH_TIMEOUT_MS", 120_000);
            const maxRetries = this.readEnvPositiveInt("ANYCRAWL_2CAPTCHA_MAX_RETRIES", 1);
            const userData = (request?.userData || {}) as any;

            if (!Number.isFinite(Number(userData._cloudflareStealthStartedAt)) || Number(userData._cloudflareStealthStartedAt) <= 0) {
                userData._cloudflareStealthStartedAt = Date.now();
            }
            if (!Number.isFinite(Number(userData._cloudflareStealthRetryCount)) || Number(userData._cloudflareStealthRetryCount) < 0) {
                userData._cloudflareStealthRetryCount = 0;
            }
            challengeState.maxRetries = maxRetries;
            challengeState.stealthTimeoutMs = stealthTimeoutMs;

            const provider = new TwoCaptchaTurnstileProvider({
                apiKey: twoCaptchaKey,
                solveTimeoutMs,
            });
            const solver = new CDPTurnstileSolver({
                provider,
                solveTimeoutMs,
            });

            await solver.setup(page);
            (page as any).__cloudflareSolver = solver;
            (page as any).__anycrawlCloudflareSolverSetup = true;
            challengeState.solverEnabled = true;

            log.info(
                `[CloudflareSolverHook] Cloudflare solver enabled for ${requestUrl || "unknown"} (provider=2captcha, timeoutMs=${solveTimeoutMs}, stealthTimeoutMs=${stealthTimeoutMs}, maxRetries=${maxRetries})`
            );
        } catch (error) {
            log.warning(
                `[CloudflareSolverHook] setup failed for ${typeof request?.url === "string" ? request.url : "unknown"}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    async onPostNavigation({ page, request }: any): Promise<void> {
        try {
            if (!page || !request) return;

            const userData = (request.userData || {}) as any;
            const challengeState = ensureChallengeState(request);
            challengeState.provider = "cloudflare";

            const queueName = userData.queueName || "unknown";
            const jobId = userData.jobId || "unknown";
            const proxyMode = this.resolveProxyMode(request);
            const requestUrl = (
                typeof request.url === "string" && request.url
                    ? request.url
                    : (request.loadedUrl || (typeof page.url === "function" ? page.url() : ""))
            );
            const solver = (page as any).__cloudflareSolver as CDPTurnstileSolver | undefined;
            const solverEnabled = Boolean(solver);
            challengeState.solverEnabled = solverEnabled;

            const markChallengeUnresolved = (errorCode: string, errorDescription: string) => {
                challengeState.solved = false;
                challengeState.unresolved = true;
                challengeState.lastError = {
                    code: errorCode,
                    message: errorDescription,
                };
            };

            const markChallengeSolved = () => {
                challengeState.solved = true;
                challengeState.unresolved = false;
                challengeState.retryRequested = false;
                challengeState.lastError = undefined;
            };

            const detection = await this.detectChallenge(page, solverEnabled ? solver : undefined);
            const challengeDetected = detection.detected;
            challengeState.detected = challengeDetected;
            if (!challengeDetected) {
                challengeState.unresolved = false;
                challengeState.retryRequested = false;
                challengeState.lastError = undefined;
                return;
            }

            if (!solverEnabled || !solver || !requestUrl) {
                markChallengeUnresolved(
                    "CHALLENGE_SOLVER_UNAVAILABLE",
                    "challenge detected but solver is not available"
                );
                if (proxyMode === "auto" && this.hasStealthProxyConfigured()) {
                    userData.options = userData.options || {};
                    // Save original proxy value for cache key consistency
                    userData._originalProxy = userData.options.proxy || proxyMode;
                    userData.options.proxy = "stealth";
                    requestProxyAction(request, "upgrade_to_stealth", "cloudflare_challenge_detected_auto_proxy");
                    log.warning(
                        `[CloudflareSolverPostHook] [${queueName}] [${jobId}] challenge detected on auto proxy, requesting stealth upgrade: ${request.url}`
                    );
                }
                return;
            }

            const stateStealthTimeoutMs = Number(challengeState.stealthTimeoutMs);
            const stealthTimeoutMs = Number.isFinite(stateStealthTimeoutMs) && stateStealthTimeoutMs > 0
                ? Math.floor(stateStealthTimeoutMs)
                : this.readEnvPositiveInt("ANYCRAWL_STEALTH_TIMEOUT_MS", 120_000);
            const stateMaxRetries = Number(challengeState.maxRetries);
            const maxRetries = Number.isFinite(stateMaxRetries) && stateMaxRetries >= 0
                ? Math.floor(stateMaxRetries)
                : this.readEnvPositiveInt("ANYCRAWL_2CAPTCHA_MAX_RETRIES", 1);
            const maxAttempts = Math.max(1, maxRetries + 1);
            const startedAtRaw = Number(userData._cloudflareStealthStartedAt);
            const startedAt = Number.isFinite(startedAtRaw) && startedAtRaw > 0
                ? startedAtRaw
                : Date.now();
            userData._cloudflareStealthStartedAt = startedAt;
            const retryCountRaw = Number(userData._cloudflareStealthRetryCount);
            const retryCount = Number.isFinite(retryCountRaw) && retryCountRaw >= 0
                ? Math.floor(retryCountRaw)
                : 0;
            challengeState.maxRetries = maxRetries;
            challengeState.retryCount = retryCount;
            const attempt = Math.min(maxAttempts, retryCount + 1);

            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs >= stealthTimeoutMs) {
                markChallengeUnresolved(
                    "TWOCAPTCHA_STEALTH_TIMEOUT",
                    `2captcha exhausted stealth timeout budget (${stealthTimeoutMs}ms)`
                );
                return;
            }

            if (retryCount > 0 && typeof (solver as any).clearCapturedParams === "function") {
                (solver as any).clearCapturedParams();
            }

            const lastSolveResult = await solver.solveDirect(requestUrl, page, {
                forceAttempt: true,
                skipInFlightWait: true,
            });
            log.info(
                `[CloudflareSolverPostHook] [${queueName}] [${jobId}] 2captcha attempt ${attempt}/${maxAttempts}: ${JSON.stringify(lastSolveResult)}`
            );

            if (lastSolveResult?.success) {
                const requestTimeout = Number(userData?.options?.timeout);
                const settleTimeoutMs = Number.isFinite(requestTimeout) && requestTimeout > 0
                    ? requestTimeout
                    : this.readEnvPositiveInt("ANYCRAWL_NAV_TIMEOUT", 30_000);

                const challengeCleared = await this.waitForChallengeClearance(
                    page,
                    request,
                    solver,
                    settleTimeoutMs
                );

                if (challengeCleared) {
                    markChallengeSolved();
                    return;
                }

                markChallengeUnresolved(
                    "TWOCAPTCHA_CHALLENGE_NOT_CLEARED",
                    "2captcha solved token but challenge page is still present"
                );

                const canRetryAfterSolve = retryCount < maxRetries && (Date.now() - startedAt) < stealthTimeoutMs;
                if (canRetryAfterSolve) {
                    userData._cloudflareStealthRetryCount = retryCount + 1;
                    challengeState.retryRequested = true;
                    challengeState.retryCount = retryCount + 1;
                    requestProxyAction(request, "rotate_proxy", "cloudflare_challenge_not_cleared_after_solve");
                    log.warning(
                        `[CloudflareSolverPostHook] [${queueName}] [${jobId}] challenge still present after solve, retrying with proxy rotation (${retryCount + 1}/${maxRetries}): ${request.url}`
                    );
                    return;
                }

                log.warning(
                    `[CloudflareSolverPostHook] [${queueName}] [${jobId}] challenge still present after solve and retry budget exhausted: ${request.url}`
                );
                return;
            }

            const totalElapsedMs = Date.now() - startedAt;
            if (totalElapsedMs >= stealthTimeoutMs) {
                markChallengeUnresolved(
                    "TWOCAPTCHA_STEALTH_TIMEOUT",
                    `2captcha exhausted stealth timeout budget (${stealthTimeoutMs}ms)`
                );
                return;
            }

            markChallengeUnresolved(
                lastSolveResult?.errorCode || "TWOCAPTCHA_SOLVE_FAILED",
                lastSolveResult?.errorDescription || `2captcha failed after ${maxAttempts} attempts`
            );

            const canRetry = retryCount < maxRetries;
            if (canRetry) {
                userData._cloudflareStealthRetryCount = retryCount + 1;
                challengeState.retryRequested = true;
                challengeState.retryCount = retryCount + 1;
                requestProxyAction(request, "rotate_proxy", "cloudflare_solver_failed");
                log.warning(
                    `[CloudflareSolverPostHook] [${queueName}] [${jobId}] scheduling retry with proxy rotation (${retryCount + 1}/${maxRetries}): ${request.url}`
                );
            }
        } catch (error) {
            log.debug(`[CloudflareSolverPostHook] Check error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async enrichPayload(context: any, payload: any): Promise<any> {
        if (!payload || typeof payload !== "object") return payload;

        const page = context?.page;
        if (!page || (page.isClosed && page.isClosed())) return payload;

        const solveResult = (page as any).__anycrawlTurnstileSolveResult;

        let params = (page as any).__anycrawlTurnstileParams;
        if (!params && typeof page.evaluate === "function") {
            try {
                params = await page.evaluate(() => (window as any).__anycrawlTurnstileParams || null);
            } catch {
                // ignore read errors
            }
        }

        if (!params || typeof params !== "object" || !(params as any).sitekey) {
            return payload;
        }

        const challengeInfo =
            payload.challenge && typeof payload.challenge === "object"
                ? payload.challenge
                : {};
        challengeInfo.provider = "cloudflare";
        challengeInfo.type = "turnstile";
        challengeInfo.detected = true;
        challengeInfo.solverExecuted = Boolean((solveResult as any)?.attempted === true);
        challengeInfo.params = params;
        payload.challenge = challengeInfo;

        const queueName = context?.request?.userData?.queueName || "unknown";
        const jobId = context?.request?.userData?.jobId || "unknown";
        const sitekey = String((params as any).sitekey);
        log.info(
            `[${queueName}] [${jobId}] turnstile params attached from runtime interception (sitekey=${sitekey.slice(0, 20)}...)`
        );
        return payload;
    }

    private readEnvPositiveInt(name: string, defaultValue: number): number {
        const raw = process.env[name];
        if (!raw) return defaultValue;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
    }

    private resolveProxyMode(request: any): string {
        const value = request?.userData?.options?.proxy;
        return typeof value === "string" ? value.trim().toLowerCase() : "";
    }

    private hasStealthProxyConfigured(): boolean {
        const raw = process.env.ANYCRAWL_PROXY_STEALTH_URL;
        if (!raw) return false;
        return raw.split(",").map((v) => v.trim()).filter(Boolean).length > 0;
    }

    private async isLikelyCloudflareChallengePage(page: any): Promise<boolean> {
        if (!page || page.isClosed?.() || typeof page.evaluate !== "function") return false;
        try {
            return await page.evaluate(() => {
                const bodyText = (document.body?.innerText || "").toLowerCase();
                const title = (document.title || "").toLowerCase();
                const html = (document.documentElement?.outerHTML || "").toLowerCase();
                const hasTurnstile =
                    Boolean(document.querySelector(".cf-turnstile, [data-sitekey], [data-site-key]"))
                    || Boolean(document.querySelector('input[name="cf-turnstile-response"]'));
                const hasChallengeForm = Boolean(
                    document.querySelector("form#challenge-form")
                    || document.querySelector('form[action*="challenge"]')
                    || document.querySelector('form[action*="/cdn-cgi/challenge-platform/"]')
                );
                const hasCloudflareRuntime = Boolean((window as any)._cf_chl_opt || (window as any).__cf_chl_opt);
                const htmlMarkers = [
                    "challenge-platform",
                    "challenge-running",
                    "challenge-stage",
                    "cf-chl-widget",
                    "challenges.cloudflare.com",
                    "/cdn-cgi/challenge-platform/",
                    "cf-turnstile",
                ];
                if (hasTurnstile || hasChallengeForm || hasCloudflareRuntime) return true;
                if (htmlMarkers.some((marker) => html.includes(marker))) return true;

                const titleMarkers = [
                    "just a moment",
                    "checking your browser",
                    "performing security verification",
                ];
                const bodyMarkers = [
                    "enable javascript and cookies to continue",
                    "security service to protect itself from online attacks",
                    "attention required",
                    "cloudflare",
                    "ray id",
                ];

                return titleMarkers.some((marker) => title.includes(marker))
                    || bodyMarkers.some((marker) => bodyText.includes(marker));
            });
        } catch {
            return false;
        }
    }

    private async detectChallenge(
        page: any,
        solver?: CDPTurnstileSolver
    ): Promise<{ detected: boolean; solverDetected: boolean; domDetected: boolean }> {
        let solverDetected = false;
        if (solver && typeof solver.isChallenge === "function") {
            try {
                solverDetected = await solver.isChallenge(page);
            } catch {
                solverDetected = false;
            }
        }

        const domDetected = await this.isLikelyCloudflareChallengePage(page);
        return {
            detected: solverDetected || domDetected,
            solverDetected,
            domDetected,
        };
    }

    private async waitForChallengeClearance(
        page: any,
        request: any,
        solver: CDPTurnstileSolver | undefined,
        timeoutMs: number
    ): Promise<boolean> {
        if (!page || page.isClosed?.()) return false;

        await this.waitForPostChallengeNavigation(page, request, Math.min(timeoutMs, 10_000));

        const deadline = Date.now() + Math.max(1_000, timeoutMs);
        while (Date.now() < deadline) {
            const detection = await this.detectChallenge(page, solver);
            if (!detection.detected) {
                return true;
            }

            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;
            await this.sleep(Math.min(750, Math.max(150, remainingMs)));
        }

        return false;
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async waitForPostChallengeNavigation(page: any, request: any, timeoutMs: number): Promise<void> {
        if (!page || page.isClosed?.()) return;
        const options = request?.userData?.options || {};
        const configuredWaitUntil = String(options.wait_until || process.env.ANYCRAWL_NAV_WAIT_UNTIL || "domcontentloaded");
        const playwrightWaitUntil =
            configuredWaitUntil === "networkidle" || configuredWaitUntil === "load" || configuredWaitUntil === "domcontentloaded"
                ? configuredWaitUntil
                : "domcontentloaded";
        const puppeteerWaitUntil =
            configuredWaitUntil === "networkidle"
                ? "networkidle0"
                : (configuredWaitUntil === "load" || configuredWaitUntil === "domcontentloaded"
                    ? configuredWaitUntil
                    : "domcontentloaded");

        const initialUrl = typeof page.url === "function" ? page.url() : String(request?.url || "");
        const navigationTimeoutMs = Math.min(timeoutMs, 15_000);

        // Prefer waiting for a real navigation/URL change after token injection.
        if (typeof page.waitForURL === "function" && initialUrl) {
            try {
                await page.waitForURL((targetUrl: any) => String(targetUrl) !== initialUrl, {
                    timeout: navigationTimeoutMs,
                    waitUntil: playwrightWaitUntil as "load" | "domcontentloaded" | "networkidle",
                });
                return;
            } catch {
                // fall through to generic navigation/load wait
            }
        }

        if (typeof page.waitForNavigation === "function") {
            try {
                await page.waitForNavigation({
                    waitUntil: puppeteerWaitUntil as "load" | "domcontentloaded" | "networkidle0",
                    timeout: navigationTimeoutMs,
                });
                return;
            } catch {
                // ignore challenge settle wait errors
            }
        }

        if (typeof page.waitForLoadState === "function") {
            try {
                await page.waitForLoadState(playwrightWaitUntil as "load" | "domcontentloaded" | "networkidle", { timeout: timeoutMs });
            } catch {
                // ignore challenge settle wait errors
            }
        }
    }
}
