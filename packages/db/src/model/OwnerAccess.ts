import type { OwnerContext } from "@anycrawl/libs";
import { eq, sql } from "drizzle-orm";
import { schemas } from "../db/index.js";

type DBExecutor = any;

export function buildTaskWhereClause(taskId: string, owner: OwnerContext): any {
    if (owner.userId) {
        return sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${owner.userId}`;
    }

    if (owner.apiKeyId) {
        return sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${owner.apiKeyId}`;
    }

    return sql`${schemas.scheduledTasks.uuid} = ${taskId}`;
}

export function buildWebhookWhereClause(webhookId: string, owner: OwnerContext): any {
    if (owner.userId) {
        return sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${owner.userId}`;
    }

    if (owner.apiKeyId) {
        return sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${owner.apiKeyId}`;
    }

    return sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;
}

export async function getOwnedTask(db: DBExecutor, taskId: string, owner: OwnerContext): Promise<any | null> {
    const whereClause = buildTaskWhereClause(taskId, owner);
    const tasks = await db
        .select()
        .from(schemas.scheduledTasks)
        .where(whereClause)
        .limit(1);

    return tasks[0] || null;
}

export async function listTasksByOwner(db: DBExecutor, owner: OwnerContext): Promise<any[]> {
    if (owner.userId) {
        return await db
            .select()
            .from(schemas.scheduledTasks)
            .where(eq(schemas.scheduledTasks.userId, owner.userId))
            .orderBy(sql`${schemas.scheduledTasks.createdAt} DESC`);
    }

    if (owner.apiKeyId) {
        return await db
            .select()
            .from(schemas.scheduledTasks)
            .where(eq(schemas.scheduledTasks.apiKey, owner.apiKeyId))
            .orderBy(sql`${schemas.scheduledTasks.createdAt} DESC`);
    }

    return await db
        .select()
        .from(schemas.scheduledTasks)
        .orderBy(sql`${schemas.scheduledTasks.createdAt} DESC`);
}

export async function getOwnedWebhook(db: DBExecutor, webhookId: string, owner: OwnerContext): Promise<any | null> {
    const whereClause = buildWebhookWhereClause(webhookId, owner);
    const webhooks = await db
        .select()
        .from(schemas.webhookSubscriptions)
        .where(whereClause)
        .limit(1);

    return webhooks[0] || null;
}

export async function listWebhooksByOwner(db: DBExecutor, owner: OwnerContext): Promise<any[]> {
    if (owner.userId) {
        return await db
            .select()
            .from(schemas.webhookSubscriptions)
            .where(eq(schemas.webhookSubscriptions.userId, owner.userId))
            .orderBy(sql`${schemas.webhookSubscriptions.createdAt} DESC`);
    }

    if (owner.apiKeyId) {
        return await db
            .select()
            .from(schemas.webhookSubscriptions)
            .where(eq(schemas.webhookSubscriptions.apiKey, owner.apiKeyId))
            .orderBy(sql`${schemas.webhookSubscriptions.createdAt} DESC`);
    }

    return await db
        .select()
        .from(schemas.webhookSubscriptions)
        .orderBy(sql`${schemas.webhookSubscriptions.createdAt} DESC`);
}
