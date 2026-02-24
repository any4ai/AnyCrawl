ALTER TABLE "scheduled_tasks" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ALTER COLUMN "user_id" DROP NOT NULL;