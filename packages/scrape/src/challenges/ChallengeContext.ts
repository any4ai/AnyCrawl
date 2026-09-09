import type { ChallengeState, ProxyAction } from "./types.js";

const CHALLENGE_STATE_KEY = "_anycrawlChallengeState";
const PROXY_ACTION_KEY = "_anycrawlProxyAction";

const getUserData = (request: any): Record<string, any> => {
    if (!request || typeof request !== "object") return {};
    if (!request.userData || typeof request.userData !== "object") {
        request.userData = {};
    }
    return request.userData;
};

export const ensureChallengeState = (request: any): ChallengeState => {
    const userData = getUserData(request);
    const state = userData[CHALLENGE_STATE_KEY];
    if (!state || typeof state !== "object") {
        userData[CHALLENGE_STATE_KEY] = {};
    }
    return userData[CHALLENGE_STATE_KEY] as ChallengeState;
};

export const resetChallengeState = (request: any, provider: string): ChallengeState => {
    const state = ensureChallengeState(request);
    state.provider = provider;
    state.pageKind = undefined;
    state.evidence = undefined;
    state.deadlineAt = undefined;
    state.phase = undefined;
    state.cleared = false;
    state.contentReady = false;
    state.requiresContentRecovery = false;
    state.sessionReused = false;
    state.verificationGeneration = undefined;
    state.verificationLeader = undefined;
    state.nativeClickCount = 0;
    state.nativeClickMethod = undefined;
    state.nativeClickAcknowledged = undefined;
    state.settledDocumentEpoch = undefined;
    state.contentRecoveryElapsedMs = undefined;
    state.solveElapsedMs = undefined;
    state.nativeWaitElapsedMs = undefined;
    state.clearanceElapsedMs = undefined;
    state.postNavigationElapsedMs = undefined;
    state.detected = false;
    state.solved = false;
    state.unresolved = false;
    state.retryRequested = false;
    state.retryCount = 0;
    state.lastError = undefined;
    state.proxyAction = undefined;
    state.reason = undefined;

    const userData = getUserData(request);
    userData[PROXY_ACTION_KEY] = undefined;
    delete userData._anycrawlPostChallengeSettled;
    delete userData._anycrawlFinalNavigationStatus;
    return state;
};

export const requestProxyAction = (
    request: any,
    action: ProxyAction,
    reason: string
): void => {
    const userData = getUserData(request);
    const state = ensureChallengeState(request);
    userData[PROXY_ACTION_KEY] = action;
    state.proxyAction = action;
    state.reason = reason;
};

export const consumeProxyAction = (request: any): ProxyAction | "" => {
    const userData = getUserData(request);
    const value = userData[PROXY_ACTION_KEY];
    userData[PROXY_ACTION_KEY] = undefined;
    return typeof value === "string" ? value as ProxyAction : "";
};
