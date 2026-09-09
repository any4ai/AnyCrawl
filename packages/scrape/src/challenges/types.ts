export type ProxyAction = "upgrade_to_stealth" | "rotate_proxy";

export interface ChallengeErrorInfo {
    code?: string;
    message?: string;
}

export interface ChallengeState {
    provider?: string;
    pageKind?: import("./cloudflare/CloudflareDetection.js").CloudflarePageKind;
    evidence?: string[];
    deadlineAt?: number;
    phase?: 'native' | 'solver' | 'settling' | 'ready' | 'failed' | 'cancelled';
    cleared?: boolean;
    contentReady?: boolean;
    requiresContentRecovery?: boolean;
    sessionReused?: boolean;
    verificationGeneration?: number;
    verificationLeader?: boolean;
    nativeClickCount?: number;
    nativeClickMethod?: string;
    nativeClickAcknowledged?: boolean;
    settledDocumentEpoch?: number;
    contentRecoveryElapsedMs?: number;
    solveElapsedMs?: number;
    nativeWaitElapsedMs?: number;
    clearanceElapsedMs?: number;
    postNavigationElapsedMs?: number;
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
