/** One application-initiated refresh across CF, status repair and content repair. */
export function reserveCloudflareReload(request: any, purpose: 'challenge' | 'status' | 'content'): boolean {
    const data = request.userData ??= {};
    if (!['GET', 'HEAD'].includes(request.method ?? 'GET') || data._anycrawlSideEffectsStarted
        || data._anycrawlExtractionStarted || request.noRetry) return false;
    if (purpose === 'content' && data._anycrawlPreNavCaptureConfigured) return false;
    const used = Math.max(Number(data._anycrawlRecoveryReloadCount) || 0, data._anycrawlPostChallengeReloadAttempted ? 1 : 0);
    if (used >= 1) return false;
    data._anycrawlRecoveryReloadCount = used + 1;
    data._anycrawlPostChallengeReloadAttempted = true;
    return true;
}
