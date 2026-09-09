import { browserResourceFailure } from '../../core/BrowserRecoveryPolicy.js';
import { reserveCloudflareReload } from './CloudflareReload.js';
import { log } from "@anycrawl/libs";
import { resetChallengeState, ensureChallengeState, requestProxyAction } from "../ChallengeContext.js";
import { CDPTurnstileSolver } from "../../solvers/CDPTurnstileSolver.js";
import { TwoCaptchaTurnstileProvider } from "../../solvers/providers/TwoCaptchaTurnstileProvider.js";
import { Deadline, DeadlineExceededError } from "../../utils/Deadline.js";
import { inspectCloudflarePage } from "./CloudflareDetection.js";
import { CloudflareNativeInteraction } from "./CloudflareNativeInteraction.js";
import { CloudflareRecoveryError, getCloudflareRecovery, startCloudflareRecovery } from "./CloudflarePageRecovery.js";
import { cloudflareSession, cloudflareOrigin, verifyCloudflareOnce, type VerificationResult } from './CloudflareSessionRegistry.js';
import type { ChallengePlugin } from "../ChallengePlugin.js";

export class CloudflareChallengeHandler implements ChallengePlugin {
    public readonly name = "cloudflare";
    async onPreNavigation({ page, request, session, nativeFingerprint = false }: any): Promise<void> {
        try {
            if (!page) return;
            page.__anycrawlAllowCloudflareResources = false;
            startCloudflareRecovery(page);
            const challengeState = resetChallengeState(request, "cloudflare");
            delete request.__anycrawlContentRecoveryError;
            const shared = cloudflareSession(page, request.url);
            if (shared?.state.flight) {
                const flight = shared.state.flight;
                const started = Number(request.userData._cloudflareStealthStartedAt) || Date.now();
                request.userData._cloudflareStealthStartedAt = started;
                const deadline = new Deadline(Math.min(page.__anycrawlBrowserDeadlineAt ?? Infinity,
                    request.userData._anycrawlBrowserDeadlineAt ?? Infinity,
                    started + this.readEnvPositiveInt('ANYCRAWL_STEALTH_TIMEOUT_MS', 120000)));
                challengeState.deadlineAt = deadline.expiresAt;
                challengeState.requiresContentRecovery = true;
                challengeState.verificationGeneration = shared.state.generation;
                challengeState.verificationLeader = false;
                const signal = getCloudflareRecovery(page)!.controller.signal;
                let result: VerificationResult;
                try { result = await deadline.run(() => flight, signal); }
                catch (error) { result = { cleared: false, code: signal.aborted ? 'CF_CANCELLED'
                    : error instanceof DeadlineExceededError ? 'CF_RECOVERY_TIMEOUT' : 'CF_RECOVERY_ERROR' }; }
                challengeState.clearanceElapsedMs = Date.now() - started;
                if (!result.cleared) {
                    challengeState.phase = result.code === 'CF_CANCELLED' ? 'cancelled' : 'failed';
                    challengeState.lastError = { code: result.code || 'CF_NATIVE_NOT_CLEARED' };
                    challengeState.unresolved = true;
                    if (challengeState.phase !== 'cancelled') this.requestFallback(request,
                        this.resolveProxyMode(request) === 'stealth' && Boolean(process.env.ANYCRAWL_2CAPTCHA_API_KEY?.trim()), deadline);
                    getCloudflareRecovery(page)?.dispose();
                    return;
                }
            }

            if (this.resolveProxyMode(request) !== "stealth") {
                return;
            }

            const requestUrl = (
                typeof request.url === "string" && request.url
                    ? request.url
                    : (request.loadedUrl || (typeof page.url === "function" ? page.url() : ""))
            );

            if (session && requestUrl && !request.userData?._anycrawlBrowserDeadlineAt) {
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
            const maxRetries = this.readEnvPositiveInt("ANYCRAWL_2CAPTCHA_MAX_RETRIES", 1, 0);
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
                preserveUserAgent: nativeFingerprint,
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

    private readonly releaseVerification = new WeakMap<object, (success: boolean) => void>();

    async onPostNavigation({ page, request, response }: any): Promise<void> {
        if (!page || !request || page.isClosed?.()) return;
        const started = Date.now();
        const recovery = getCloudflareRecovery(page) ?? startCloudflareRecovery(page);
        recovery.lastResponse ??= response;
        const state = ensureChallengeState(request);
        const solver = page.__cloudflareSolver as CDPTurnstileSolver | undefined;
        state.solverEnabled = Boolean(solver);
        const native = new CloudflareNativeInteraction();
        try {
            let session = cloudflareSession(page);
            let observedGeneration = session?.state.generation ?? 0;
            const outerDeadline = Math.min(page.__anycrawlBrowserDeadlineAt ?? Infinity,
                request.userData?._anycrawlBrowserDeadlineAt ?? Infinity);
            const initialDeadline = new Deadline(Math.min(outerDeadline,
                Date.now() + this.readEnvPositiveInt('ANYCRAWL_NAV_TIMEOUT', 30000)));
            let detection = await initialDeadline.run(() => this.detectChallenge(page), recovery.controller.signal);
            state.detected = detection.detected;
            state.pageKind = detection.kind; state.evidence = detection.evidence;
            if (!detection.detected && !session?.state.seen) return;
            state.requiresContentRecovery = true;
            state.sessionReused = !detection.detected && Boolean(session?.state.seen);
            state.contentReady = false; state.nativeClickCount ??= 0;
            page.__anycrawlAllowCloudflareResources = true;
            const previousStart = Number(request.userData._cloudflareStealthStartedAt);
            const recoveryStart = previousStart > 0 ? previousStart : started;
            request.userData._cloudflareStealthStartedAt = recoveryStart;
            state.deadlineAt = Math.min(outerDeadline, recoveryStart +
                (state.stealthTimeoutMs || this.readEnvPositiveInt('ANYCRAWL_STEALTH_TIMEOUT_MS', 120000)));
            const deadline = new Deadline(state.deadlineAt);
            let refreshed = false;
            for (let attempt = 0; attempt < 2; attempt++) {
                const signal = recovery.controller.signal;
                deadline.check(); signal.throwIfAborted();
                if (detection.detected) {
                    state.detected = true; state.unresolved = true; state.cleared = false;
                    state.phase = 'native';
                    // Redirects get their own origin state; no clearance is copied.
                    if (session?.origin !== cloudflareOrigin(page)) {
                        session = cloudflareSession(page); observedGeneration = session?.state.generation ?? 0;
                    }
                    const operation = (ownerSignal: AbortSignal) => this.verifyCurrentPage(
                        page, request, deadline, native, started, ownerSignal)
                        .then(result => ({ ...result, origin: cloudflareOrigin(page) }));
                    const verification = session
                        ? verifyCloudflareOnce(session, observedGeneration, deadline, signal, operation)
                        : { leader: true, generation: 1, promise: operation(signal) };
                    state.verificationGeneration = verification.generation;
                    state.verificationLeader = verification.leader;
                    const result = await verification.promise;
                    state.clearanceElapsedMs = Date.now() - started;
                    if (!verification.leader) state.nativeWaitElapsedMs = state.clearanceElapsedMs;
                    if (!result.cleared) {
                        state.phase = result.code === 'CF_CANCELLED' ? 'cancelled' : 'failed';
                        state.lastError = { code: result.code || 'CF_NATIVE_NOT_CLEARED' };
                        state.unresolved = true; state.cleared = false; state.solved = false;
                        if (state.phase !== 'cancelled') this.requestFallback(request, Boolean(solver), deadline);
                        return;
                    }
                    // Followers must inspect their OWN document. An already
                    // committed challenge page may need one refresh to use the cookie.
                    detection = await deadline.run(() => this.detectChallenge(page), signal);
                    if (!verification.leader && detection.detected && !refreshed && reserveCloudflareReload(request, 'challenge')) {
                        refreshed = true;
                        const latest = await deadline.run(() => page.reload({
                            waitUntil: 'domcontentloaded', timeout: deadline.remainingMs,
                        }), signal);
                        if (latest) recovery.lastResponse = latest;
                        detection = await deadline.run(() => this.detectChallenge(page), signal);
                    }
                    observedGeneration = verification.generation;
                    if (detection.detected) continue;
                }
                // A known origin with no current challenge gets content recovery,
                // without any native click, paid task or unconditional reload.
                while (detection.kind === 'unknown' && deadline.remainingMs > 0) {
                    await deadline.sleep(500, signal);
                    detection = await deadline.run(() => this.detectChallenge(page), signal);
                }
                state.pageKind = detection.kind; state.evidence = detection.evidence;
                if (detection.detected) continue;
                if (!detection.ready) throw new CloudflareRecoveryError('CF_DOCUMENT_NOT_READY');
                this.markCleared(request);
                try {
                    await ensureCloudflarePageRecovered(page, request);
                    return;
                } catch (error) {
                    if (!(error instanceof CloudflareRecoveryError) || error.code !== 'CF_CHALLENGE_REAPPEARED') throw error;
                    detection = await deadline.run(() => this.detectChallenge(page), signal);
                }
            }
            state.phase = 'failed'; state.unresolved = true; state.cleared = false;
            state.lastError = { code: 'CF_CHALLENGE_REAPPEARED' };
            this.requestFallback(request, Boolean(solver), deadline);
        } catch (error) {
            if (error instanceof Error && browserResourceFailure(error)) request.__anycrawlContentRecoveryError = error;
            const contentTimeout = state.cleared && (error instanceof DeadlineExceededError || error instanceof CloudflareRecoveryError && error.code === 'CF_CONTENT_TIMEOUT');
            state.phase = recovery.controller.signal.aborted ? 'cancelled' : 'failed';
            state.contentReady = false;
            state.lastError = { code: contentTimeout ? 'CF_CONTENT_TIMEOUT' : recovery.controller.signal.aborted ? 'CF_CANCELLED'
                : error instanceof DeadlineExceededError ? 'CF_RECOVERY_TIMEOUT' : error instanceof CloudflareRecoveryError ? error.code : 'CF_RECOVERY_ERROR',
                message: error instanceof Error ? error.message : String(error) };
            state.unresolved = !state.cleared;
            // Plugin errors are caught by the orchestrator. Base gates extraction.
        } finally {
            if (state.detected) state.nativeWaitElapsedMs ??= Date.now() - started;
            state.postNavigationElapsedMs = Date.now() - started;
            await native.dispose();
            if (!state.requiresContentRecovery || ['failed', 'cancelled'].includes(state.phase ?? '')) recovery.dispose();
        }
    }

    private async verifyCurrentPage(page: any, request: any, deadline: Deadline,
        native: CloudflareNativeInteraction, started: number, signal: AbortSignal): Promise<VerificationResult> {
        const state = ensureChallengeState(request);
        const recovery = getCloudflareRecovery(page)!;
        const solver = page.__cloudflareSolver as CDPTurnstileSolver | undefined;
        const nativeDeadline = new Deadline(Math.min(started + 60000, deadline.expiresAt));
        while (nativeDeadline.remainingMs > 0) {
            signal.throwIfAborted();
            let detection;
            try { detection = await nativeDeadline.run(() => this.detectChallenge(page), signal); }
            catch (error) { if (!signal.aborted && nativeDeadline.remainingMs <= 0) break; throw error; }
            state.pageKind = detection.kind; state.evidence = detection.evidence;
            if (detection.ready) {
                state.nativeWaitElapsedMs ??= Date.now() - started;
                this.markCleared(request);
                return { cleared: true };
            }
            if (['blocked', 'rate_limited', 'http_error'].includes(detection.kind)) break;
            if (detection.detected && (state.nativeClickCount ?? 0) < 2) {
                const epoch = recovery.epoch;
                try {
                    const click = await nativeDeadline.run(() => native.tryClick(page, nativeDeadline, signal, () => recovery.epoch === epoch, epoch), signal);
                    if (click) {
                        state.nativeClickCount = (state.nativeClickCount ?? 0) + 1;
                        state.nativeClickMethod = click.source;
                        state.nativeClickAcknowledged = click.acknowledged;
                        log.info(`[cloudflare] native_click_applied method=${click.source} count=${state.nativeClickCount}`);
                    }
                } catch (error) {
                    if (signal.aborted) throw error;
                    if (nativeDeadline.remainingMs <= 0) break;
                    // Navigation invalidates the pending lookup; observe the current document again.
                }
            }
            if (nativeDeadline.remainingMs <= 0) break;
            try { await nativeDeadline.sleep(500, signal); }
            catch (error) { if (!signal.aborted && nativeDeadline.remainingMs <= 0) break; throw error; }
        }
        state.nativeWaitElapsedMs = Date.now() - started;
        await native.dispose();
        deadline.check(); signal.throwIfAborted();
        // Navigation can commit at the native-stage boundary. Continue a
        // loading document under the SAME total budget; HTTP 200 alone is
        // never clearance and never permits extraction.
        let transition = await deadline.run(() => this.detectChallenge(page), signal);
        while (transition.kind === 'unknown' && deadline.remainingMs > 0) {
            await deadline.sleep(500, signal);
            transition = await deadline.run(() => this.detectChallenge(page), signal);
        }
        if (transition.ready) { this.markCleared(request); return { cleared: true }; }
        // Reserve time for verification and the post-CF document. Never start a task we cannot await.
        const solverDeadline = new Deadline(deadline.expiresAt - 30000);
        if (solver && solverDeadline.remainingMs >= 10000) {
            state.phase = 'solver';
            const solveStarted = Date.now();
            const result = await solver.solveDirect(page.url(), page, { forceAttempt: true, deadlineAt: solverDeadline.expiresAt, signal });
            state.solveElapsedMs = Date.now() - solveStarted;
            // Native completion can race a failed/cancelled provider result.
            const detection = await deadline.run(() => this.detectChallenge(page), signal);
            state.pageKind = detection.kind; state.evidence = detection.evidence;
            if (detection.ready) { this.markCleared(request); return { cleared: true }; }
            if (result.success) {
                while (deadline.remainingMs > 0) {
                    const current = await deadline.run(() => this.detectChallenge(page), signal);
                    if (current.ready) { this.markCleared(request); return { cleared: true }; }
                    if (['blocked', 'rate_limited', 'http_error'].includes(current.kind)) break;
                    // A new visible challenge after callback is not a solved document.
                    if (current.detected && Date.now() - solveStarted - state.solveElapsedMs > 10000) break;
                    await deadline.sleep(500, signal);
                }
            }
            state.lastError = { code: result.errorCode || 'TWOCAPTCHA_CHALLENGE_NOT_CLEARED',
                message: result.errorDescription || 'Solver result did not clear the current challenge' };
        } else {
            state.lastError = { code: solver ? 'CF_RECOVERY_BUDGET_EXHAUSTED' : 'CF_NATIVE_NOT_CLEARED',
                message: solver ? 'Insufficient remaining budget for a solver task and page recovery' : 'Native challenge did not clear and no solver is available for this mode' };
        }
        state.phase = 'failed'; state.solved = false; state.unresolved = true;
        return { cleared: false, code: state.lastError?.code };
    }

    private markCleared(request: any): void {
        const state = ensureChallengeState(request);
        this.releaseVerification.get(request)?.(true);
        state.solved = true; state.cleared = true; state.unresolved = false;
        state.retryRequested = false; state.proxyAction = undefined; state.reason = undefined; state.lastError = undefined;
        request.userData._anycrawlProxyAction = undefined;
        state.phase = 'settling';
        log.info(`[cloudflare] clearance_confirmed request=${request.id ?? request.userData?.jobId ?? 'unknown'}`);
    }

    private requestFallback(request: any, solverAvailable: boolean, deadline: Deadline): void {
        if (deadline.remainingMs <= 0) return;
        const state = ensureChallengeState(request);
        const mode = request.userData?._originalProxy ?? this.resolveProxyMode(request);
        if (mode === 'auto' && this.hasStealthProxyConfigured()) {
            request.userData._originalProxy ??= request.userData.options.proxy;
            request.userData.options.proxy = 'stealth';
            requestProxyAction(request, 'upgrade_to_stealth', 'cloudflare_native_not_cleared');
            return;
        }
        const count = Number(request.userData._cloudflareStealthRetryCount) || 0;
        const limit = state.maxRetries ?? this.readEnvPositiveInt('ANYCRAWL_2CAPTCHA_MAX_RETRIES', 1, 0);
        if (solverAvailable && count < limit) {
            state.retryRequested = true; state.retryCount = count + 1;
            request.userData._cloudflareStealthRetryCount = count + 1;
            requestProxyAction(request, 'rotate_proxy', 'cloudflare_challenge_not_cleared');
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

    private readEnvPositiveInt(name: string, defaultValue: number, minimum = 1): number {
        const raw = process.env[name];
        if (!raw) return defaultValue;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed >= minimum ? parsed : defaultValue;
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

    private async detectChallenge(page: any) {
        const response = await getCloudflareRecovery(page)?.documentResponse();
        if (response?.status === 407) throw Object.assign(new Error('Proxy authentication failed'), { statusCode: 407 });
        return inspectCloudflarePage(page, response);
    }
}

/** Run outside the best-effort plugin dispatcher so failed shared verification
 * cannot be swallowed and followed by a fresh navigation/verification attempt. */
export function throwIfCloudflarePreNavigationFailed(request: any): void {
    const state = ensureChallengeState(request);
    if (state.requiresContentRecovery && ['failed', 'cancelled'].includes(state.phase ?? '')) {
        if (!state.proxyAction) request.noRetry = true;
        throw new CloudflareRecoveryError(state.lastError?.code || 'CF_RECOVERY_ERROR');
    }
}

export async function ensureCloudflarePageRecovered(page: any, request: any): Promise<void> {
    const state = ensureChallengeState(request);
    if (!(state.detected || state.requiresContentRecovery) || !state.cleared) return;
    const recovery = getCloudflareRecovery(page);
    if (!recovery || !state.deadlineAt) throw new CloudflareRecoveryError('CF_RECOVERY_STATE_MISSING');
    const stoppedCode = page.isClosed?.() || recovery.controller.signal.aborted ? 'CF_CANCELLED'
        : !recovery.isSettled && Date.now() >= state.deadlineAt ? 'CF_CONTENT_TIMEOUT' : undefined;
    if (stoppedCode) {
        state.contentReady = false; state.phase = stoppedCode === 'CF_CANCELLED' ? 'cancelled' : 'failed';
        state.lastError = { code: stoppedCode, message: stoppedCode };
        delete request.userData._anycrawlPostChallengeSettled;
        throw new CloudflareRecoveryError(stoppedCode);
    }
    if (recovery.isSettled) return;
    state.contentReady = false; state.phase = 'settling';
    delete request.userData._anycrawlPostChallengeSettled;
    const started = Date.now();
    const deadline = new Deadline(state.deadlineAt);
    try {
        while (true) {
            try { await recovery.settle(deadline); break; }
            catch (error) {
                if (!(error instanceof CloudflareRecoveryError)
                    || !['CF_CONTENT_INVALID', 'CF_CONTENT_UNVERIFIED'].includes(error.code)
                    || deadline.remainingMs <= 0 || typeof page.reload !== 'function'
                    || !reserveCloudflareReload(request, 'content')) throw error;
                state.contentRecoveryReloads = (state.contentRecoveryReloads ?? 0) + 1;
                state.contentEvidence = recovery.lastSample?.evidence;
                const response = await deadline.run(() => page.reload({ waitUntil: 'domcontentloaded',
                    timeout: Math.min(deadline.remainingMs, Number(request.userData?.options?.timeout) || 30000) }), recovery.controller.signal);
                if (response) recovery.lastResponse = response;
                // Navigation resets evidence/snapshot in the observer. A new CF
                // challenge is handled by the existing outer verification loop.
            }
        }
        state.contentReady = true; state.phase = 'ready'; state.settledDocumentEpoch = recovery.epoch;
        state.contentValidationVersion = recovery.snapshot?.version;
        state.contentEvidence = recovery.lastSample?.evidence;
        state.lastError = undefined; state.contentRecoveryElapsedMs = Date.now() - started;
        request.userData._anycrawlPostChallengeSettled = true;
        log.info(`[cloudflare] content_recovered request=${request.id ?? request.userData?.jobId ?? 'unknown'} elapsedMs=${state.contentRecoveryElapsedMs} textLength=${recovery.lastSample?.textLength ?? 0}`);
    } catch (error) {
        if (error instanceof Error && browserResourceFailure(error)) {
            request.__anycrawlContentRecoveryError = error; state.phase = 'failed'; state.contentReady = false;
            throw error;
        }
        const code = error instanceof DeadlineExceededError ? 'CF_CONTENT_TIMEOUT'
            : error instanceof CloudflareRecoveryError ? error.code
            : recovery.controller.signal.aborted ? 'CF_CANCELLED' : 'CF_CONTENT_RECOVERY_ERROR';
        state.lastError = { code, message: error instanceof Error ? error.message : String(error) };
        state.contentEvidence = recovery.lastSample?.evidence;
        state.contentReady = false; state.phase = code === 'CF_CANCELLED' ? 'cancelled' : 'failed';
        if (code === 'CF_CHALLENGE_REAPPEARED') { state.cleared = false; state.solved = false; state.unresolved = true; }
        throw new CloudflareRecoveryError(code);
    }
}

/** Final gate before templates or expensive transformations start. */
export async function prepareCloudflareSnapshot(context: any): Promise<void> {
    const state = ensureChallengeState(context.request);
    if (!state.requiresContentRecovery) return;
    const recovery = getCloudflareRecovery(context.page);
    if (!recovery || !state.deadlineAt) throw new CloudflareRecoveryError('CF_CONTENT_UNVERIFIED');
    const deadline = new Deadline(state.deadlineAt);
    while (true) {
        if (context.request.__anycrawlContentRecoveryError) throw context.request.__anycrawlContentRecoveryError;
        try {
            await ensureCloudflarePageRecovered(context.page, context.request);
            if (!state.contentReady || !recovery.isSettled) throw new CloudflareRecoveryError(state.lastError?.code ?? 'CF_CONTENT_UNVERIFIED');
            try {
                // This is the sole HTML acquisition, after user-requested waits
                // and before template/format work. Live signals share that read.
                context.__anycrawlVerifiedContentSnapshot = await recovery.captureSnapshot(deadline);
            } catch (error) {
                if (error instanceof CloudflareRecoveryError && error.code === 'CF_CONTENT_CHANGED') continue;
                if (error instanceof CloudflareRecoveryError && ['CF_CONTENT_INVALID', 'CF_CONTENT_UNVERIFIED'].includes(error.code)) {
                    await ensureCloudflarePageRecovered(context.page, context.request);
                    continue;
                }
                throw error;
            }
            state.contentValidationVersion = 1;
            if (recovery.lastResponse) context.response = recovery.lastResponse;
            return;
        } catch (error) {
            const orchestrator = context.request.__anycrawlChallengeOrchestrator;
            if (error instanceof CloudflareRecoveryError && error.code === 'CF_CHALLENGE_REAPPEARED' && orchestrator) {
                await orchestrator.onPostNavigation(context);
                if (state.contentReady && state.cleared) continue;
            }
            state.contentReady = false; state.phase = recovery.controller.signal.aborted ? 'cancelled' : 'failed';
            if (state.proxyAction && !recovery.controller.signal.aborted && deadline.remainingMs > 0) {
                throw new Error(state.proxyAction === 'upgrade_to_stealth' ? 'ANYCRAWL_PROXY_ACTION_UPGRADE_TO_STEALTH' : 'ANYCRAWL_PROXY_ACTION_ROTATE_PROXY');
            }
            if (error instanceof Error && browserResourceFailure(error)) throw error;
            const code = error instanceof DeadlineExceededError ? 'CF_CONTENT_TIMEOUT'
                : error instanceof CloudflareRecoveryError ? error.code : recovery.controller.signal.aborted ? 'CF_CANCELLED' : 'CF_CONTENT_RECOVERY_ERROR';
            state.lastError = { code }; context.request.noRetry = true;
            throw new CloudflareRecoveryError(code);
        }
    }
}
