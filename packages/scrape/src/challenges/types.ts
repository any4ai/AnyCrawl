export type ProxyAction = "upgrade_to_stealth" | "rotate_proxy";

export interface ChallengeErrorInfo {
    code?: string;
    message?: string;
}

export interface ChallengeState {
    provider?: string;
    detected?: boolean;
    solved?: boolean;
    unresolved?: boolean;
    retryRequested?: boolean;
    retryCount?: number;
    maxRetries?: number;
    stealthTimeoutMs?: number;
    solverEnabled?: boolean;
    lastError?: ChallengeErrorInfo;
    proxyAction?: ProxyAction;
    reason?: string;
}
