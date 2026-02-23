import { and, eq, sql } from "drizzle-orm";
import { log } from "@anycrawl/libs/log";
import type { BillingChargeDetailsV1, BillingChargeItem, BillingMode } from "@anycrawl/libs";
import { getDB, schemas } from "../db/index.js";

type DBExecutor = any;

export interface ChargeDeltaByJobIdParams {
    jobId: string;
    delta: number;
    reason?: string;
    idempotencyKey?: string;
    chargeDetails?: BillingChargeDetailsV1;
    dbOrTx?: DBExecutor;
}

export interface ChargeToUsedByJobIdParams {
    jobId: string;
    targetUsed: number;
    reason?: string;
    idempotencyKey?: string;
    chargeDetails?: BillingChargeDetailsV1;
    dbOrTx?: DBExecutor;
}

export interface BillingChargeResult {
    jobId: string;
    charged: number;
    currentUsed: number;
    remainingCredits?: number;
}

interface JobBillingContext {
    apiKey: string;
    currentUsed: number;
}

interface BillingLedgerReservation {
    jobId: string;
    apiKey: string;
    mode: BillingMode;
    reason: string;
    idempotencyKey: string;
    charged: number;
    beforeUsed: number;
    afterUsed: number;
    chargeDetails?: BillingChargeDetailsV1;
    createdAt: Date;
}

export class Billing {
    private static normalizePositiveNumber(value: number): number {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) return 0;
        return numeric;
    }

    private static normalizeNonNegativeNumber(value: number): number {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric < 0) return 0;
        return numeric;
    }

    private static normalizeIdempotencyKey(value?: string): string | undefined {
        if (typeof value !== "string") return undefined;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }

    private static isPlainObject(value: unknown): value is Record<string, unknown> {
        if (!value || typeof value !== "object") return false;
        const proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    }

    private static normalizeChargeDetails(
        chargeDetails: BillingChargeDetailsV1 | undefined,
        charged: number,
        reason: string,
    ): BillingChargeDetailsV1 | undefined {
        const normalizedCharged = this.normalizePositiveNumber(charged);
        if (normalizedCharged <= 0 || !chargeDetails || !Array.isArray(chargeDetails.items)) {
            return undefined;
        }

        const calculator = typeof chargeDetails.calculator === "string" && chargeDetails.calculator.trim().length > 0
            ? chargeDetails.calculator.trim()
            : "billing_v1";

        const items: BillingChargeItem[] = chargeDetails.items
            .map((item) => {
                if (!item || typeof item !== "object") return null;
                const code = typeof item.code === "string" ? item.code.trim() : "";
                const credits = Number(item.credits);
                if (!code || !Number.isFinite(credits) || credits <= 0) return null;

                const normalizedItem: BillingChargeItem = {
                    code,
                    credits,
                };

                if (this.isPlainObject(item.meta)) {
                    normalizedItem.meta = item.meta;
                }

                return normalizedItem;
            })
            .filter((item): item is BillingChargeItem => Boolean(item));

        const itemsTotal = items.reduce((sum, item) => sum + item.credits, 0);
        const matchesCharged = Math.abs(itemsTotal - normalizedCharged) < 1e-9;

        if (items.length > 0 && matchesCharged) {
            return {
                version: 1,
                basis: "charged_delta",
                calculator,
                total: normalizedCharged,
                items,
            };
        }

        log.warning(
            `[BILLING] chargeDetails mismatch reason=${reason} charged=${normalizedCharged} itemsTotal=${itemsTotal}, fallback to unattributed_adjustment`
        );

        return {
            version: 1,
            basis: "charged_delta",
            calculator,
            total: normalizedCharged,
            items: [{
                code: "unattributed_adjustment",
                credits: normalizedCharged,
                meta: {
                    reason,
                    source_total: itemsTotal,
                },
            }],
        };
    }

    private static buildDefaultIdempotencyKey(params: {
        mode: BillingMode;
        jobId: string;
        reason: string;
        beforeUsed: number;
        afterUsed: number;
    }): string {
        const { mode, jobId, reason, beforeUsed, afterUsed } = params;
        if (mode === "target") {
            return `billing:target:${jobId}:${afterUsed}:${reason}`;
        }
        return `billing:delta:${jobId}:${beforeUsed}->${afterUsed}:${reason}`;
    }

    private static resolveIdempotencyKey(params: {
        mode: BillingMode;
        jobId: string;
        reason: string;
        beforeUsed: number;
        afterUsed: number;
        idempotencyKey?: string;
    }): string {
        const normalized = this.normalizeIdempotencyKey(params.idempotencyKey);
        if (normalized) return normalized;
        return this.buildDefaultIdempotencyKey({
            mode: params.mode,
            jobId: params.jobId,
            reason: params.reason,
            beforeUsed: params.beforeUsed,
            afterUsed: params.afterUsed,
        });
    }

    private static async reserveLedgerEntry(tx: DBExecutor, reservation: BillingLedgerReservation): Promise<boolean> {
        const [inserted] = await tx
            .insert(schemas.billingLedger)
            .values({
                jobId: reservation.jobId,
                apiKey: reservation.apiKey,
                mode: reservation.mode,
                reason: reservation.reason,
                idempotencyKey: reservation.idempotencyKey,
                charged: reservation.charged,
                beforeUsed: reservation.beforeUsed,
                afterUsed: reservation.afterUsed,
                chargeDetails: reservation.chargeDetails,
                createdAt: reservation.createdAt,
            })
            .onConflictDoNothing({
                target: schemas.billingLedger.idempotencyKey,
            })
            .returning({
                idempotencyKey: schemas.billingLedger.idempotencyKey,
            });

        return !!inserted;
    }

    private static async fillLedgerCreditsSnapshot(
        tx: DBExecutor,
        idempotencyKey: string,
        charged: number,
        remainingCredits: number | undefined,
    ): Promise<void> {
        if (typeof remainingCredits !== "number") {
            return;
        }

        await tx
            .update(schemas.billingLedger)
            .set({
                beforeCredits: remainingCredits + charged,
                afterCredits: remainingCredits,
            })
            .where(eq(schemas.billingLedger.idempotencyKey, idempotencyKey));
    }

    private static async runInTransaction<T>(dbOrTx: DBExecutor | undefined, work: (tx: DBExecutor) => Promise<T>): Promise<T> {
        if (dbOrTx) {
            return work(dbOrTx);
        }

        const db = await getDB();
        return db.transaction(async (tx: DBExecutor) => work(tx));
    }

    private static async getJobBillingContext(tx: DBExecutor, jobId: string): Promise<JobBillingContext> {
        const [jobRow] = await tx
            .select({
                apiKey: schemas.jobs.apiKey,
                creditsUsed: schemas.jobs.creditsUsed,
            })
            .from(schemas.jobs)
            .where(eq(schemas.jobs.jobId, jobId))
            .limit(1);

        if (!jobRow) {
            throw new Error(`Job not found: ${jobId}`);
        }
        if (!jobRow.apiKey) {
            throw new Error(`Job has no apiKey: ${jobId}`);
        }

        return {
            apiKey: jobRow.apiKey,
            currentUsed: Number(jobRow.creditsUsed ?? 0),
        };
    }

    public static async chargeDeltaByJobId({
        jobId,
        delta,
        reason = "unknown",
        idempotencyKey,
        chargeDetails,
        dbOrTx,
    }: ChargeDeltaByJobIdParams): Promise<BillingChargeResult> {
        const normalizedDelta = this.normalizePositiveNumber(delta);
        if (!jobId) {
            throw new Error("jobId is required for chargeDeltaByJobId");
        }

        return this.runInTransaction(dbOrTx, async (tx) => {
            const context = await this.getJobBillingContext(tx, jobId);
            if (normalizedDelta <= 0) {
                return {
                    jobId,
                    charged: 0,
                    currentUsed: context.currentUsed,
                };
            }

            const beforeUsed = context.currentUsed;
            const afterUsed = context.currentUsed + normalizedDelta;
            const effectiveIdempotencyKey = this.resolveIdempotencyKey({
                mode: "delta",
                jobId,
                reason,
                beforeUsed,
                afterUsed,
                idempotencyKey,
            });
            const normalizedChargeDetails = this.normalizeChargeDetails(chargeDetails, normalizedDelta, reason);
            const now = new Date();
            const reserved = await this.reserveLedgerEntry(tx, {
                jobId,
                apiKey: context.apiKey,
                mode: "delta",
                reason,
                idempotencyKey: effectiveIdempotencyKey,
                charged: normalizedDelta,
                beforeUsed,
                afterUsed,
                chargeDetails: normalizedChargeDetails,
                createdAt: now,
            });

            if (!reserved) {
                log.info(`[BILLING] chargeDelta deduped jobId=${jobId} reason=${reason} key=${effectiveIdempotencyKey}`);
                return {
                    jobId,
                    charged: 0,
                    currentUsed: context.currentUsed,
                };
            }

            await tx
                .update(schemas.jobs)
                .set({
                    creditsUsed: sql`${schemas.jobs.creditsUsed} + ${normalizedDelta}`,
                    deductedAt: now,
                    updatedAt: now,
                })
                .where(eq(schemas.jobs.jobId, jobId));

            const [updatedApiKey] = await tx
                .update(schemas.apiKey)
                .set({
                    credits: sql`${schemas.apiKey.credits} - ${normalizedDelta}`,
                    lastUsedAt: now,
                })
                .where(eq(schemas.apiKey.uuid, context.apiKey))
                .returning({
                    credits: schemas.apiKey.credits,
                });

            const remainingCredits = typeof updatedApiKey?.credits === "number" ? updatedApiKey.credits : undefined;
            const currentUsed = afterUsed;
            await this.fillLedgerCreditsSnapshot(tx, effectiveIdempotencyKey, normalizedDelta, remainingCredits);
            log.info(`[BILLING] chargeDelta jobId=${jobId} reason=${reason} charged=${normalizedDelta} used=${currentUsed}`);

            return {
                jobId,
                charged: normalizedDelta,
                currentUsed,
                remainingCredits,
            };
        });
    }

    public static async chargeToUsedByJobId({
        jobId,
        targetUsed,
        reason = "unknown",
        idempotencyKey,
        chargeDetails,
        dbOrTx,
    }: ChargeToUsedByJobIdParams): Promise<BillingChargeResult> {
        if (!jobId) {
            throw new Error("jobId is required for chargeToUsedByJobId");
        }

        const normalizedTargetUsed = this.normalizeNonNegativeNumber(targetUsed);
        const MAX_RETRIES = 5;

        return this.runInTransaction(dbOrTx, async (tx) => {
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                const context = await this.getJobBillingContext(tx, jobId);
                const delta = normalizedTargetUsed - context.currentUsed;

                if (delta <= 0) {
                    return {
                        jobId,
                        charged: 0,
                        currentUsed: context.currentUsed,
                    };
                }

                const now = new Date();
                const [updatedJob] = await tx
                    .update(schemas.jobs)
                    .set({
                        creditsUsed: normalizedTargetUsed,
                        deductedAt: now,
                        updatedAt: now,
                    })
                    .where(
                        and(
                            eq(schemas.jobs.jobId, jobId),
                            eq(schemas.jobs.creditsUsed, context.currentUsed),
                        )
                    )
                    .returning({
                        creditsUsed: schemas.jobs.creditsUsed,
                    });

                if (!updatedJob) {
                    continue;
                }

                const beforeUsed = context.currentUsed;
                const effectiveIdempotencyKey = this.resolveIdempotencyKey({
                    mode: "target",
                    jobId,
                    reason,
                    beforeUsed,
                    afterUsed: normalizedTargetUsed,
                    idempotencyKey,
                });
                const normalizedChargeDetails = this.normalizeChargeDetails(chargeDetails, delta, reason);
                const reserved = await this.reserveLedgerEntry(tx, {
                    jobId,
                    apiKey: context.apiKey,
                    mode: "target",
                    reason,
                    idempotencyKey: effectiveIdempotencyKey,
                    charged: delta,
                    beforeUsed,
                    afterUsed: normalizedTargetUsed,
                    chargeDetails: normalizedChargeDetails,
                    createdAt: now,
                });

                if (!reserved) {
                    throw new Error(`Duplicate billing idempotency key for chargeToUsedByJobId: ${effectiveIdempotencyKey}`);
                }

                const [updatedApiKey] = await tx
                    .update(schemas.apiKey)
                    .set({
                        credits: sql`${schemas.apiKey.credits} - ${delta}`,
                        lastUsedAt: now,
                    })
                    .where(eq(schemas.apiKey.uuid, context.apiKey))
                    .returning({
                        credits: schemas.apiKey.credits,
                    });

                const remainingCredits = typeof updatedApiKey?.credits === "number" ? updatedApiKey.credits : undefined;
                await this.fillLedgerCreditsSnapshot(tx, effectiveIdempotencyKey, delta, remainingCredits);
                log.info(`[BILLING] chargeToUsed jobId=${jobId} reason=${reason} target=${normalizedTargetUsed} charged=${delta}`);

                return {
                    jobId,
                    charged: delta,
                    currentUsed: normalizedTargetUsed,
                    remainingCredits,
                };
            }

            throw new Error(`Failed to chargeToUsed after ${MAX_RETRIES} retries for jobId: ${jobId}`);
        });
    }
}
