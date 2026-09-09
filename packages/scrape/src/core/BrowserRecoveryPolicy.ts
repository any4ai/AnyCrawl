import { NonRetryableError } from 'crawlee';

export type FailureKind = 'configuration' | 'cancelled' | 'timeout' | 'content' | 'proxy_transport' | 'proxy_auth' | 'browser' | 'challenge' | 'blocked' | 'rate_limited' | 'http' | 'unknown';
export interface RecoveryDecision {
    failureKind: FailureKind;
    scope: 'request' | 'origin' | 'lease';
    retryAllowed: boolean;
    leaseAction: 'keep' | 'exclude_origin' | 'retire';
    proxyAction: 'none' | 'rotate' | 'upgrade';
    cacheAction: 'none' | 'upgrade_on_success';
}
export class BrowserIdentityChangedError extends Error {}
export class BrowserOriginUnavailableError extends Error {}

/** Crawl children inherit options, never the parent's execution deadline or failed identities. */
export function freshBrowserRequestData(source: Record<string, any>): Record<string, any> {
    const data: Record<string, any> = { ...source, options: { ...source.options } };
    if (source._originalProxy) data.options.proxy = source._originalProxy;
    for (const key of Object.keys(data)) {
        if (key.startsWith('_anycrawl') || key.startsWith('_cloudflare') || key === '_proxyTier' || key === '_originalProxy') delete data[key];
    }
    return data;
}

export function requestOrigin(url?: string): string | undefined {
    try { const parsed = url ? new URL(url) : undefined;
        return parsed && ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : undefined;
    } catch { return undefined; }
}

/** Classify once at the browser boundary, before Crawlee's retry/cleanup hooks. */
export function classifyBrowserFailure(context: any, error: Error): RecoveryDecision {
    const request = context.request;
    const data = request?.userData ?? {};
    const state = data._anycrawlChallengeState ?? {};
    const message = error.message ?? '';
    const code = (error as any).code ?? state.lastError?.code;
    const decision: RecoveryDecision = { failureKind: 'unknown', scope: 'request', retryAllowed: false,
        leaseAction: 'keep', proxyAction: 'none', cacheAction: 'none' };
    const finish = (kind: FailureKind) => {
        decision.failureKind = kind;
        if (request?.noRetry || data._anycrawlSideEffectsStarted || !['GET', 'HEAD'].includes(request?.method ?? 'GET')) {
            decision.retryAllowed = false;
            decision.proxyAction = 'none';
            decision.cacheAction = 'none';
        }
        return decision;
    };
    if (error instanceof NonRetryableError) return finish('configuration');
    if (error.name === 'AbortError' || code === 'CF_CANCELLED' || state.phase === 'cancelled') return finish('cancelled');
    if (['TimeoutError', 'InternalTimeoutError', 'DeadlineExceededError'].includes(error.name)
        || ['TimeoutError', 'InternalTimeoutError'].includes(error.constructor.name)
        || /^Navigation timed out after \d+(?:\.\d+)? seconds\.$/.test(message)
        || ['CF_CONTENT_TIMEOUT', 'CF_RECOVERY_TIMEOUT'].includes(code)
        || Number.isFinite(data._anycrawlBrowserDeadlineAt) && Date.now() >= data._anycrawlBrowserDeadlineAt) return finish('timeout');
    if (state.cleared && state.phase === 'failed' || typeof code === 'string' && code.startsWith('CF_CONTENT_')) return finish('content');
    const transport = /\b(?:ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED)\b/.test(message);
    const auth = /\b(?:ERR_PROXY_AUTH_FAILED|ERR_INVALID_AUTH_CREDENTIALS)\b/.test(message)
        || (error as any).statusCode === 407 || /^Received blocked status code: 407\b/.test(message);
    if (transport || auth || context.__anycrawlLeaseFailure || error instanceof BrowserIdentityChangedError || error.name === 'TargetClosedError'
        || /^(?:browserType\.launch: |browser\.newPage: )?Browser has been closed/.test(message)) {
        decision.scope = 'lease'; decision.leaseAction = 'retire'; decision.retryAllowed = true;
        decision.proxyAction = transport && (data._originalProxy ?? data.options?.proxy) === 'auto' ? 'upgrade' : 'rotate';
        return finish(auth ? 'proxy_auth' : transport ? 'proxy_transport' : 'browser');
    }
    if ((error as any).statusCode === 429 || /^Received blocked status code: 429\b/.test(message)) return finish('rate_limited');
    const upgrade = message === 'ANYCRAWL_PROXY_ACTION_UPGRADE_TO_STEALTH' || message === 'ANYCRAWL_PROXY_UPGRADE_TO_STEALTH';
    const rotate = message === 'ANYCRAWL_PROXY_ACTION_ROTATE_PROXY' || message === 'ANYCRAWL_STEALTH_RETRY_WITH_NEW_PROXY';
    const blocked = /^Received blocked status code: 403\b/.test(message) || error instanceof BrowserOriginUnavailableError;
    if (upgrade || rotate || blocked) {
        decision.scope = 'origin'; decision.leaseAction = 'exclude_origin'; decision.retryAllowed = true;
        const mode = data._originalProxy ?? data.options?.proxy;
        decision.proxyAction = upgrade && mode === 'auto' ? 'upgrade' : 'rotate';
        decision.cacheAction = decision.proxyAction === 'upgrade' ? 'upgrade_on_success' : 'none';
        return finish(blocked ? 'blocked' : 'challenge');
    }
    if ((error as any).statusCode || /^Received blocked status code:/.test(message)) return finish('http');
    return finish('unknown');
}

/** Idempotent: the manager and errorHandler may both observe the same error. */
export function applyBrowserRecovery(context: any, error: Error): RecoveryDecision {
    if (context.__anycrawlRecoveryError === error) return context.__anycrawlRecoveryDecision;
    const decision = classifyBrowserFailure(context, error);
    context.__anycrawlRecoveryError = error;
    context.__anycrawlRecoveryDecision = decision;
    const request = context.request;
    request.userData ??= {};
    const data = request.userData;
    request.noRetry = !decision.retryAllowed;
    data._anycrawlRecoveryAction = decision.proxyAction;
    if (decision.cacheAction === 'upgrade_on_success') data._anycrawlUpgradeEvidence = true;
    if (decision.failureKind === 'proxy_auth' && context.proxyInfo?.stickyProxyTemplate) {
        const excluded: string[] = data._anycrawlExcludedProxyIds ??= [];
        // Store only a non-secret stable ID, never credentials in request metadata.
        const id = context.proxyInfo.stickyProxyId;
        if (id && !excluded.includes(id)) excluded.push(id);
    }
    return decision;
}
