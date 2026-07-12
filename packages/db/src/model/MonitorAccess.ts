import type { OwnerContext } from "@anycrawl/libs";
import { eq, sql } from "drizzle-orm";
import { schemas } from "../db/index.js";

type DBExecutor = any;

export function buildMonitorWhereClause(monitorId: string, owner: OwnerContext): any {
    if (owner.userId) {
        return sql`${schemas.monitors.uuid} = ${monitorId} AND ${schemas.monitors.userId} = ${owner.userId}`;
    }

    if (owner.apiKeyId) {
        return sql`${schemas.monitors.uuid} = ${monitorId} AND ${schemas.monitors.apiKey} = ${owner.apiKeyId}`;
    }

    return sql`${schemas.monitors.uuid} = ${monitorId}`;
}

export async function getOwnedMonitor(db: DBExecutor, monitorId: string, owner: OwnerContext): Promise<any | null> {
    const whereClause = buildMonitorWhereClause(monitorId, owner);
    const monitors = await db
        .select()
        .from(schemas.monitors)
        .where(whereClause)
        .limit(1);

    return monitors[0] || null;
}

export async function listMonitorsByOwner(db: DBExecutor, owner: OwnerContext): Promise<any[]> {
    if (owner.userId) {
        return await db
            .select()
            .from(schemas.monitors)
            .where(eq(schemas.monitors.userId, owner.userId))
            .orderBy(sql`${schemas.monitors.createdAt} DESC`);
    }

    if (owner.apiKeyId) {
        return await db
            .select()
            .from(schemas.monitors)
            .where(eq(schemas.monitors.apiKey, owner.apiKeyId))
            .orderBy(sql`${schemas.monitors.createdAt} DESC`);
    }

    return await db
        .select()
        .from(schemas.monitors)
        .orderBy(sql`${schemas.monitors.createdAt} DESC`);
}

/**
 * Find the monitor whose underlying scheduled task matches the given uuid.
 * Used by the post-processing hook to detect monitor-managed executions.
 */
export async function getMonitorByScheduledTask(db: DBExecutor, scheduledTaskUuid: string): Promise<any | null> {
    const monitors = await db
        .select()
        .from(schemas.monitors)
        .where(eq(schemas.monitors.scheduledTaskUuid, scheduledTaskUuid))
        .limit(1);

    return monitors[0] || null;
}

/**
 * Return the most recent snapshot for a (monitor, url) that predates the current run.
 * Ordered by capturedAt desc; offset 1 skips the just-written snapshot when called after insert,
 * so callers should call this BEFORE inserting the new snapshot (offset 0).
 */
export async function getLatestSnapshot(db: DBExecutor, monitorUuid: string, url: string): Promise<any | null> {
    const rows = await db
        .select()
        .from(schemas.monitorSnapshots)
        .where(
            sql`${schemas.monitorSnapshots.monitorUuid} = ${monitorUuid} AND ${schemas.monitorSnapshots.url} = ${url}`
        )
        .orderBy(sql`${schemas.monitorSnapshots.capturedAt} DESC`)
        .limit(1);

    return rows[0] || null;
}

export async function listSnapshotsByMonitor(
    db: DBExecutor,
    monitorUuid: string,
    skip: number,
    limit: number
): Promise<any[]> {
    return await db
        .select()
        .from(schemas.monitorSnapshots)
        .where(eq(schemas.monitorSnapshots.monitorUuid, monitorUuid))
        .orderBy(sql`${schemas.monitorSnapshots.capturedAt} DESC`)
        .limit(limit)
        .offset(skip);
}

export async function listChangesByMonitor(
    db: DBExecutor,
    monitorUuid: string,
    skip: number,
    limit: number
): Promise<any[]> {
    return await db
        .select()
        .from(schemas.monitorChanges)
        .where(eq(schemas.monitorChanges.monitorUuid, monitorUuid))
        .orderBy(sql`${schemas.monitorChanges.createdAt} DESC`)
        .limit(limit)
        .offset(skip);
}
