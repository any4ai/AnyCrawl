export class DeadlineExceededError extends Error {
    constructor() {
        super("Execution deadline exceeded");
        this.name = "DeadlineExceededError";
    }
}

/** An absolute deadline shared by nested operations; waiting never resets it. */
export class Deadline {
    constructor(public readonly expiresAt: number) {}
    get remainingMs(): number {
        return Math.max(0, this.expiresAt - Date.now());
    }
    check(): void {
        if (this.remainingMs <= 0) throw new DeadlineExceededError();
    }
    async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        this.check();
        signal?.throwIfAborted();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
            return await Promise.race([
                Promise.resolve().then(operation),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new DeadlineExceededError()), this.remainingMs);
                    onAbort = () => reject(signal!.reason);
                    signal?.addEventListener("abort", onAbort, { once: true });
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
            if (onAbort) signal?.removeEventListener("abort", onAbort);
        }
    }
    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
        this.check();
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
            const finish = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
            const timer = setTimeout(finish, Math.min(ms, this.remainingMs));
            const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(signal!.reason); };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
}
