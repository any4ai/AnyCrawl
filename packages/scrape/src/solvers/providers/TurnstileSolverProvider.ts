export interface TurnstileSolverInput {
    pageUrl: string;
    sitekey: string;
    data?: string;
    pagedata?: string;
    action?: string;
    userAgent?: string;
}

export interface TurnstileSolverResult {
    success: boolean;
    token?: string;
    userAgent?: string;
    taskId?: string;
    errorCode?: string;
    errorDescription?: string;
}

export interface TurnstileSolverProvider {
    readonly name: string;
    solve(input: TurnstileSolverInput): Promise<TurnstileSolverResult>;
}
