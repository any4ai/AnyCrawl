CREATE TABLE "monitor_changes" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"monitor_uuid" uuid NOT NULL,
	"url" text NOT NULL,
	"from_snapshot_uuid" uuid,
	"to_snapshot_uuid" uuid,
	"change_type" text NOT NULL,
	"diff_text" text,
	"diff_json" jsonb,
	"judgment" jsonb,
	"notified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_snapshots" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"monitor_uuid" uuid NOT NULL,
	"task_execution_uuid" uuid,
	"url" text NOT NULL,
	"content_hash" text NOT NULL,
	"content" text,
	"extracted" jsonb,
	"status" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid,
	"user_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"monitor_type" text DEFAULT 'webpage' NOT NULL,
	"scheduled_task_uuid" uuid,
	"targets" jsonb NOT NULL,
	"goal" text,
	"track_mode" text DEFAULT 'text' NOT NULL,
	"extract_schema" jsonb,
	"diff_options" jsonb,
	"notify_options" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor_changes" ADD CONSTRAINT "monitor_changes_monitor_uuid_monitors_uuid_fk" FOREIGN KEY ("monitor_uuid") REFERENCES "public"."monitors"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_snapshots" ADD CONSTRAINT "monitor_snapshots_monitor_uuid_monitors_uuid_fk" FOREIGN KEY ("monitor_uuid") REFERENCES "public"."monitors"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_snapshots" ADD CONSTRAINT "monitor_snapshots_task_execution_uuid_task_executions_uuid_fk" FOREIGN KEY ("task_execution_uuid") REFERENCES "public"."task_executions"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_api_key_id_api_key_uuid_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_scheduled_task_uuid_scheduled_tasks_uuid_fk" FOREIGN KEY ("scheduled_task_uuid") REFERENCES "public"."scheduled_tasks"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_changes_monitor_idx" ON "monitor_changes" USING btree ("monitor_uuid","created_at");--> statement-breakpoint
CREATE INDEX "monitor_snapshots_monitor_url_idx" ON "monitor_snapshots" USING btree ("monitor_uuid","url","captured_at");--> statement-breakpoint
CREATE INDEX "monitors_api_key_idx" ON "monitors" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "monitors_user_id_idx" ON "monitors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "monitors_scheduled_task_idx" ON "monitors" USING btree ("scheduled_task_uuid");