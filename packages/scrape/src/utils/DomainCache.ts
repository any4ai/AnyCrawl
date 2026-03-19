import { Utils } from "../Utils.js";

export class DomainCache<T> {
    private readonly local = new Map<string, { value: T; ts: number }>();

    constructor(
        private readonly prefix: string,
        private readonly redisTtl = 86400,
        private readonly localTtl = 300_000,
    ) {}

    async get(domain: string): Promise<T | null> {
        const l = this.local.get(domain);
        if (l && Date.now() - l.ts < this.localTtl) return l.value;
        try {
            const redis = Utils.getInstance().getRedisConnection();
            const raw = await redis.get(`${this.prefix}:${domain}`);
            if (!raw) return null;
            const value = JSON.parse(raw) as T;
            this.local.set(domain, { value, ts: Date.now() });
            return value;
        } catch {
            return null;
        }
    }

    async set(domain: string, value: T): Promise<void> {
        try {
            const redis = Utils.getInstance().getRedisConnection();
            await redis.set(
                `${this.prefix}:${domain}`,
                JSON.stringify(value),
                "EX",
                this.redisTtl,
            );
            this.local.set(domain, { value, ts: Date.now() });
        } catch {
            // fire-and-forget
        }
    }
}
