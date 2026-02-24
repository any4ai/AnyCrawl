import { z } from "zod";
import { CronExpressionParser } from "cron-parser";

export const createTaskSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().nullable().optional(),
    cron_expression: z.string().refine(
        (val) => {
            try {
                CronExpressionParser.parse(val);
                return true;
            } catch {
                return false;
            }
        },
        "Invalid cron expression"
    ),
    timezone: z.string().default("UTC"),
    task_type: z.enum(["scrape", "crawl", "search", "template"]),
    task_payload: z.object({}).passthrough(),
    concurrency_mode: z.enum(["skip", "queue"]).default("skip"),
    max_executions_per_day: z.number().int().positive().nullable().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.any()).optional(),
    webhook_ids: z.array(z.string().uuid()).optional(),
    webhook_url: z.string().url().optional(),
});

export const updateTaskSchema = createTaskSchema.partial();

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
