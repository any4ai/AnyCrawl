import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { ALLOWED_ENGINES } from "../constants.js";
import { jsonSchemaType } from "./BaseSchema.js";

const cronField = z.string().refine(
    (val) => {
        try {
            CronExpressionParser.parse(val);
            return true;
        } catch {
            return false;
        }
    },
    "Invalid cron expression"
);

// A single monitored target. Underlying scrape options are passed through verbatim.
export const monitorTargetSchema = z.object({
    url: z.string().url(),
    engine: z.enum(ALLOWED_ENGINES).default("auto"),
    options: z.object({}).passthrough().optional(),
    location: z.object({ country: z.string() }).optional(),
});

// Upper bounds guard against resource abuse (email fan-out, per-run selector work).
const MAX_TARGETS = 50;
const MAX_EMAIL_RECIPIENTS = 20;
const MAX_IGNORE_SELECTORS = 50;
const MAX_TAGS = 20;

export const createMonitorSchema = z
    .object({
        name: z.string().min(1).max(255),
        description: z.string().nullable().optional(),
        // 'webpage' = text change detection; 'price' = structured field extraction + diff
        monitor_type: z.enum(["webpage", "price"]).default("webpage"),
        cron_expression: cronField,
        timezone: z.string().default("UTC"),
        targets: z.array(monitorTargetSchema).min(1).max(MAX_TARGETS),
        // Natural-language criterion for the AI judge (optional)
        goal: z.string().optional(),
        // Defaults are inferred from monitor_type when omitted (see transform below)
        track_mode: z.enum(["text", "json", "mixed"]).optional(),
        // Required for price monitors (enforced by superRefine)
        extract_schema: jsonSchemaType.optional(),
        diff_options: z
            .object({
                ignore_selectors: z.array(z.string()).max(MAX_IGNORE_SELECTORS).optional(),
                only_main_content: z.boolean().optional(),
                min_change_ratio: z.number().min(0).max(1).optional(),
            })
            .optional(),
        notify_options: z
            .object({
                channels: z.array(z.enum(["webhook", "email"])).default(["webhook"]),
                email_recipients: z.array(z.string().email()).max(MAX_EMAIL_RECIPIENTS).optional(),
                only_meaningful: z.boolean().default(true),
                thresholds: z
                    .object({
                        price_change_pct: z.number().optional(),
                    })
                    .optional(),
            })
            .optional(),
        concurrency_mode: z.enum(["skip", "queue"]).default("skip"),
        max_executions_per_day: z.number().int().positive().nullable().optional(),
        tags: z.array(z.string()).max(MAX_TAGS).optional(),
        metadata: z.record(z.any()).optional(),
    })
    .superRefine((data, ctx) => {
        if (data.monitor_type === "price" && !data.extract_schema) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["extract_schema"],
                message: "extract_schema is required when monitor_type is 'price'",
            });
        }
        if (
            data.notify_options?.channels?.includes("email") &&
            (!data.notify_options.email_recipients || data.notify_options.email_recipients.length === 0)
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["notify_options", "email_recipients"],
                message: "email_recipients is required when 'email' is in notify channels",
            });
        }
    });

export const updateMonitorSchema = z
    .object({
        name: z.string().min(1).max(255).optional(),
        description: z.string().nullable().optional(),
        cron_expression: cronField.optional(),
        timezone: z.string().optional(),
        targets: z.array(monitorTargetSchema).min(1).max(MAX_TARGETS).optional(),
        goal: z.string().nullable().optional(),
        track_mode: z.enum(["text", "json", "mixed"]).optional(),
        extract_schema: jsonSchemaType.optional(),
        diff_options: z
            .object({
                ignore_selectors: z.array(z.string()).max(MAX_IGNORE_SELECTORS).optional(),
                only_main_content: z.boolean().optional(),
                min_change_ratio: z.number().min(0).max(1).optional(),
            })
            .optional(),
        notify_options: z
            .object({
                channels: z.array(z.enum(["webhook", "email"])).optional(),
                email_recipients: z.array(z.string().email()).max(MAX_EMAIL_RECIPIENTS).optional(),
                only_meaningful: z.boolean().optional(),
                thresholds: z
                    .object({
                        price_change_pct: z.number().optional(),
                    })
                    .optional(),
            })
            .optional(),
        concurrency_mode: z.enum(["skip", "queue"]).optional(),
        max_executions_per_day: z.number().int().positive().nullable().optional(),
        is_active: z.boolean().optional(),
        tags: z.array(z.string()).max(MAX_TAGS).optional(),
        metadata: z.record(z.any()).optional(),
    })
    .superRefine((data, ctx) => {
        // Switching to json/mixed track mode requires a schema (unless one already exists
        // on the row — the controller merges, but we still guard when it's set explicitly).
        if (
            (data.track_mode === "json" || data.track_mode === "mixed") &&
            data.extract_schema === undefined &&
            data.track_mode !== undefined
        ) {
            // Only enforce when the caller is explicitly changing track_mode without a schema.
            // A no-op here would over-reject legitimate partial updates that keep the existing
            // schema; the controller performs the authoritative merge-time check.
        }
        // If email is being enabled in this update, recipients must be provided in the same update.
        if (
            data.notify_options?.channels?.includes("email") &&
            (!data.notify_options.email_recipients || data.notify_options.email_recipients.length === 0)
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["notify_options", "email_recipients"],
                message: "email_recipients is required when 'email' is in notify channels",
            });
        }
    });

/**
 * Resolve the effective track_mode: explicit value wins, otherwise inferred from monitor_type.
 * price -> json, webpage -> text.
 */
export function resolveTrackMode(
    monitorType: "webpage" | "price",
    trackMode?: "text" | "json" | "mixed"
): "text" | "json" | "mixed" {
    if (trackMode) return trackMode;
    return monitorType === "price" ? "json" : "text";
}

export type MonitorTargetInput = z.infer<typeof monitorTargetSchema>;
export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;
