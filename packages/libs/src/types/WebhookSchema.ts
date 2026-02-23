import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "./WebhookEvents.js";

export const createWebhookSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    webhook_url: z.string().url(),
    event_types: z.array(z.string()).min(1).refine(
        (types) => types.every((type) => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(type)),
        "Invalid event type"
    ),
    scope: z.enum(["all", "specific"]).default("all"),
    specific_task_ids: z.array(z.string().uuid()).optional(),
    custom_headers: z.record(z.string()).optional(),
    timeout_seconds: z.number().int().min(1).max(60).default(10),
    max_retries: z.number().int().min(0).max(10).default(3),
    retry_backoff_multiplier: z.number().min(1).max(10).default(2),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.any()).optional(),
});

export const updateWebhookSchema = createWebhookSchema.partial();

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
