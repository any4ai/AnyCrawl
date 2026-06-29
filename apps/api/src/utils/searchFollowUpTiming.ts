export const SEARCH_SCRAPE_PARTIAL_TIMEOUT_MS = 60_000;

export function resolveSearchFollowUpWaitMs(timeoutMs?: number): number {
    return Math.min(timeoutMs ?? SEARCH_SCRAPE_PARTIAL_TIMEOUT_MS, SEARCH_SCRAPE_PARTIAL_TIMEOUT_MS);
}

export async function collectSettledWithinTimeout<T>(
    promises: Promise<T>[],
    timeoutMs: number,
    onError?: (error: unknown) => void,
): Promise<{ settled: T[]; timedOut: boolean }> {
    if (promises.length === 0) {
        return { settled: [], timedOut: false };
    }

    const settled: T[] = [];
    let completedCount = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
    });

    const allSettled = Promise.all(promises.map(async (promise) => {
        try {
            settled.push(await promise);
        } catch (error) {
            onError?.(error);
        } finally {
            completedCount += 1;
        }
    })).then(() => "settled" as const);

    const result = await Promise.race([allSettled, timeout]);

    if (timeoutId) {
        clearTimeout(timeoutId);
    }

    return {
        settled: [...settled],
        timedOut: result === "timeout" && completedCount < promises.length,
    };
}
