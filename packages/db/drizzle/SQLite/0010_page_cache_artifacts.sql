CREATE TABLE `page_cache_entries` (
	`uuid` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`url_hash` text NOT NULL,
	`normalized_url` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`domain` text NOT NULL,
	`engine` text,
	`proxy_mode` text,
	`status_code` integer NOT NULL,
	`content_type` text,
	`content_length` integer,
	`title` text,
	`description` text,
	`has_screenshot` integer DEFAULT false,
	`scraped_at` integer NOT NULL,
	`last_accessed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `page_cache_artifacts` (
	`uuid` text PRIMARY KEY NOT NULL,
	`entry_uuid` text NOT NULL,
	`artifact_type` text NOT NULL,
	`artifact_options_hash` text NOT NULL,
	`storage_mode` text NOT NULL,
	`content_text` text,
	`content_json` text,
	`s3_key` text,
	`content_hash` text,
	`content_bytes` integer DEFAULT 0 NOT NULL,
	`scraped_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`entry_uuid`) REFERENCES `page_cache_entries`(`uuid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_cache_entries_snapshot_idx` ON `page_cache_entries` (`snapshot_hash`);
--> statement-breakpoint
CREATE INDEX `page_cache_entries_url_hash_idx` ON `page_cache_entries` (`url_hash`);
--> statement-breakpoint
CREATE INDEX `page_cache_entries_domain_idx` ON `page_cache_entries` (`domain`);
--> statement-breakpoint
CREATE INDEX `page_cache_entries_scraped_at_idx` ON `page_cache_entries` (`scraped_at`);
--> statement-breakpoint
CREATE INDEX `page_cache_entries_last_accessed_at_idx` ON `page_cache_entries` (`last_accessed_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_cache_artifacts_entry_type_options_idx` ON `page_cache_artifacts` (`entry_uuid`, `artifact_type`, `artifact_options_hash`);
--> statement-breakpoint
CREATE INDEX `page_cache_artifacts_entry_idx` ON `page_cache_artifacts` (`entry_uuid`);
--> statement-breakpoint
CREATE INDEX `page_cache_artifacts_type_idx` ON `page_cache_artifacts` (`artifact_type`);
--> statement-breakpoint
CREATE INDEX `page_cache_artifacts_storage_mode_idx` ON `page_cache_artifacts` (`storage_mode`);
--> statement-breakpoint
CREATE INDEX `page_cache_artifacts_scraped_at_idx` ON `page_cache_artifacts` (`scraped_at`);
