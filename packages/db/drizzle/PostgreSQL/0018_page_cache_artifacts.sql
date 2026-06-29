CREATE TABLE "page_cache_entries" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"normalized_url" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"domain" text NOT NULL,
	"engine" text,
	"proxy_mode" text,
	"status_code" integer NOT NULL,
	"content_type" text,
	"content_length" integer,
	"title" text,
	"description" text,
	"has_screenshot" boolean DEFAULT false,
	"scraped_at" timestamp with time zone NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_cache_artifacts" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"entry_uuid" uuid NOT NULL,
	"artifact_type" text NOT NULL,
	"artifact_options_hash" text NOT NULL,
	"storage_mode" text NOT NULL,
	"content_text" text,
	"content_json" jsonb,
	"s3_key" text,
	"content_hash" text,
	"content_bytes" integer DEFAULT 0 NOT NULL,
	"scraped_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_cache_artifacts" ADD CONSTRAINT "page_cache_artifacts_entry_uuid_page_cache_entries_uuid_fk" FOREIGN KEY ("entry_uuid") REFERENCES "public"."page_cache_entries"("uuid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "page_cache_entries_snapshot_idx" ON "page_cache_entries" USING btree ("snapshot_hash");
--> statement-breakpoint
CREATE INDEX "page_cache_entries_url_hash_idx" ON "page_cache_entries" USING btree ("url_hash");
--> statement-breakpoint
CREATE INDEX "page_cache_entries_domain_idx" ON "page_cache_entries" USING btree ("domain");
--> statement-breakpoint
CREATE INDEX "page_cache_entries_scraped_at_idx" ON "page_cache_entries" USING btree ("scraped_at");
--> statement-breakpoint
CREATE INDEX "page_cache_entries_last_accessed_at_idx" ON "page_cache_entries" USING btree ("last_accessed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "page_cache_artifacts_entry_type_options_idx" ON "page_cache_artifacts" USING btree ("entry_uuid","artifact_type","artifact_options_hash");
--> statement-breakpoint
CREATE INDEX "page_cache_artifacts_entry_idx" ON "page_cache_artifacts" USING btree ("entry_uuid");
--> statement-breakpoint
CREATE INDEX "page_cache_artifacts_type_idx" ON "page_cache_artifacts" USING btree ("artifact_type");
--> statement-breakpoint
CREATE INDEX "page_cache_artifacts_storage_mode_idx" ON "page_cache_artifacts" USING btree ("storage_mode");
--> statement-breakpoint
CREATE INDEX "page_cache_artifacts_scraped_at_idx" ON "page_cache_artifacts" USING btree ("scraped_at");
