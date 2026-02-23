import crypto from "crypto";
import { randomUUID } from "crypto";
import { getDB, eq, sql, schemas, buildWebhookWhereClause } from "@anycrawl/db";
import { log, type OwnerContext } from "@anycrawl/libs";

function buildWebhookAssociationFilter(taskId: string, owner: OwnerContext) {
    const dbType = process.env.ANYCRAWL_API_DB_TYPE?.toLowerCase() ?? "sqlite";
    let associationFilter: any;

    if (dbType === "postgresql") {
        associationFilter = sql`${schemas.webhookSubscriptions.scope} = 'specific'
            AND ${schemas.webhookSubscriptions.specificTaskIds} IS NOT NULL
            AND ${schemas.webhookSubscriptions.specificTaskIds} @> ${JSON.stringify([taskId])}::jsonb`;
    } else if (dbType === "sqlite") {
        associationFilter = sql`${schemas.webhookSubscriptions.scope} = 'specific'
            AND ${schemas.webhookSubscriptions.specificTaskIds} IS NOT NULL
            AND json_valid(${schemas.webhookSubscriptions.specificTaskIds})
            AND EXISTS (
                SELECT 1
                FROM json_each(${schemas.webhookSubscriptions.specificTaskIds})
                WHERE json_each.value = ${taskId}
            )`;
    } else {
        // Fallback for unknown db types: keep behavior safe/correct.
        associationFilter = eq(schemas.webhookSubscriptions.scope, "specific");
    }

    if (owner.userId) {
        return sql`${associationFilter} AND ${schemas.webhookSubscriptions.userId} = ${owner.userId}`;
    }

    if (owner.apiKeyId) {
        return sql`${associationFilter} AND ${schemas.webhookSubscriptions.apiKey} = ${owner.apiKeyId}`;
    }

    return associationFilter;
}

export async function handleWebhookAssociations(
    taskId: string,
    owner: OwnerContext,
    webhookIds?: string[],
    webhookUrl?: string
): Promise<void> {
    const db = await getDB();

    if (webhookUrl) {
        try {
            const webhookUuid = randomUUID();
            const secret = crypto.randomBytes(32).toString("hex");

            await db.insert(schemas.webhookSubscriptions).values({
                uuid: webhookUuid,
                apiKey: owner.apiKeyId,
                userId: owner.userId || null,
                name: `Webhook for task: ${taskId}`,
                description: "Auto-created webhook for scheduled task",
                webhookUrl: webhookUrl,
                webhookSecret: secret,
                scope: "specific",
                specificTaskIds: [taskId],
                eventTypes: ["task.executed", "task.failed", "task.paused", "task.resumed"],
                isActive: true,
                customHeaders: {},
                timeoutSeconds: 10,
                maxRetries: 3,
                retryBackoffMultiplier: 2,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            log.info(`Auto-created webhook ${webhookUuid} for task ${taskId}`);
        } catch (error) {
            log.error(`Failed to create webhook for task ${taskId}: ${error}`);
        }
    }

    if (webhookIds && webhookIds.length > 0) {
        for (const webhookId of webhookIds) {
            try {
                const whereClause = buildWebhookWhereClause(webhookId, owner);
                const webhook = await db
                    .select()
                    .from(schemas.webhookSubscriptions)
                    .where(whereClause)
                    .limit(1);

                if (!webhook.length) {
                    log.warning(`Webhook ${webhookId} not found or not owned by user`);
                    continue;
                }

                const currentTaskIds = (webhook[0].specificTaskIds as string[]) || [];
                if (!currentTaskIds.includes(taskId)) {
                    const updatedTaskIds = [...currentTaskIds, taskId];
                    await db
                        .update(schemas.webhookSubscriptions)
                        .set({
                            specificTaskIds: updatedTaskIds,
                            scope: "specific",
                            updatedAt: new Date(),
                        })
                        .where(eq(schemas.webhookSubscriptions.uuid, webhookId));

                    log.info(`Associated webhook ${webhookId} with task ${taskId}`);
                }
            } catch (error) {
                log.error(`Failed to associate webhook ${webhookId} with task ${taskId}: ${error}`);
            }
        }
    }
}

export async function removeWebhookAssociations(taskId: string, owner: OwnerContext): Promise<void> {
    const db = await getDB();

    try {
        const webhooks = await db
            .select()
            .from(schemas.webhookSubscriptions)
            .where(buildWebhookAssociationFilter(taskId, owner));

        for (const webhook of webhooks) {
            const currentTaskIds = (webhook.specificTaskIds as string[]) || [];
            if (!currentTaskIds.includes(taskId)) continue;
            const updatedTaskIds = currentTaskIds.filter((id) => id !== taskId);

            await db
                .update(schemas.webhookSubscriptions)
                .set({
                    specificTaskIds: updatedTaskIds.length > 0 ? updatedTaskIds : [],
                    updatedAt: new Date(),
                })
                .where(eq(schemas.webhookSubscriptions.uuid, webhook.uuid));

            log.info(`Removed task ${taskId} from webhook ${webhook.uuid}`);
        }
    } catch (error) {
        log.error(`Failed to remove webhook associations for task ${taskId}: ${error}`);
    }
}
