ALTER TABLE "jobs" ADD COLUMN "traffic_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "traffic_request_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "traffic_response_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "traffic_request_count" integer DEFAULT 0 NOT NULL;