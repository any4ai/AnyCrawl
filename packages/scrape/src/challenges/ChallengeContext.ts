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
