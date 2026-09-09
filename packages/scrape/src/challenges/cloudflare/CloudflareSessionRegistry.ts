import { Deadline } from '../../utils/Deadline.js';

export interface VerificationResult { cleared: boolean; code?: string; origin?: string; }
export interface CloudflareOriginState {
    seen: boolean;
    confirmedAt?: number;
    generation: number;
    result?: VerificationResult;
    flight?: Promise<VerificationResult>;
}
interface ContextState {
    origins: Map<string, CloudflareOriginState>;
    controller: AbortController;
}
const contexts = new WeakMap<object, ContextState>();

/** Use the actual context object for either driver; never a Crawlee session id. */
export function cloudflareBrowserContext(page: any): object | undefined {
    return typeof page.context === 'function' ? page.context()
        : typeof page.browserContext === 'function' ? page.browserContext() : undefined;
}
export function cloudflareOrigin(page: any, targetUrl?: string): string | undefined {
    try { const url = new URL(targetUrl ?? page.url()); return /^https?:$/.test(url.protocol) ? url.origin : undefined; }
    catch { return undefined; }
}
function contextState(context: any): ContextState {
    let state = contexts.get(context);
    if (!state) {
        state = { origins: new Map(), controller: new AbortController() };
        contexts.set(context, state);
        // Puppeteer contexts have no close event. The manager disposes those
        // when their owning lease closes; its pages also cancel their owners.
        context.once?.('close', () => disposeCloudflareContext(context));
    }
    return state;
}
export function disposeCloudflareContext(context: object): void {
    const state = contexts.get(context);
    if (!state) return;
    state.controller.abort(new Error('CF_CONTEXT_CLOSED'));
    state.origins.clear();
    // Keep the aborted tombstone: a late callback must not revive a closed context.
}
export function confirmedCloudflareOrigin(context: object, origin: string): boolean {
    const state = contexts.get(context);
    return !state?.controller.signal.aborted && Boolean(state?.origins.get(origin)?.confirmedAt);
}
export function cloudflareSession(page: any, targetUrl?: string): { state: CloudflareOriginState; signal: AbortSignal; origin: string } | undefined {
    const context = cloudflareBrowserContext(page), origin = cloudflareOrigin(page, targetUrl);
    if (!context || !origin) return undefined;
    const owner = contextState(context);
    owner.controller.signal.throwIfAborted();
    let state = owner.origins.get(origin);
    if (!state) { state = { seen: false, generation: 0 }; owner.origins.set(origin, state); }
    return { state, signal: owner.controller.signal, origin };
}

/** Followers share clearance only. Their deadline/abort never cancels the owner. */
export function verifyCloudflareOnce(
    session: NonNullable<ReturnType<typeof cloudflareSession>>,
    observedGeneration: number, deadline: Deadline, signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<VerificationResult>,
): { leader: boolean; generation: number; promise: Promise<VerificationResult> } {
    deadline.check(); signal.throwIfAborted(); session.signal.throwIfAborted();
    const state = session.state;
    if (state.flight) {
        const flight = state.flight;
        return { leader: false, generation: state.generation, promise: deadline.run(() => flight, signal) };
    }
    // A concurrent observer that arrived before this generation finished must
    // consume its failure as well as its success, rather than restarting it.
    if (state.generation > observedGeneration && state.result) return {
        leader: false, generation: state.generation, promise: Promise.resolve(state.result),
    };
    state.seen = true;
    state.confirmedAt = undefined;
    const generation = ++state.generation;
    const ownerSignal = AbortSignal.any([signal, session.signal]);
    const flight = deadline.run(() => operation(ownerSignal), ownerSignal)
        .catch((error): VerificationResult => ({ cleared: false, code: ownerSignal.aborted ? 'CF_CANCELLED'
            : error?.code ?? (deadline.remainingMs <= 0 ? 'CF_RECOVERY_TIMEOUT' : 'CF_RECOVERY_ERROR') }))
        .then(result => {
            if (ownerSignal.aborted) result = { cleared: false, code: 'CF_CANCELLED' };
            if (!session.signal.aborted && state.generation === generation) {
                state.result = result;
                if (result.cleared && result.origin === session.origin) state.confirmedAt = Date.now();
            }
            return result;
        }).finally(() => { if (state.flight === flight) state.flight = undefined; });
    state.flight = flight;
    return { leader: true, generation, promise: flight };
}
