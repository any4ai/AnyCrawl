CREATE TABLE `page_cache` (
	`uuid` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`url_hash` text NOT NULL,
	`domain` text NOT NULL,
	`s3_key` text NOT NULL,
	`content_hash` text,
	`title` text,
	`description` text,
	`status_code` integer NOT NULL,
	`content_type` text,
	`content_length` integer,
	`options_hash` text NOT NULL,
	`engine` text,
	`is_mobile` integer DEFAULT false,
	`has_proxy` integer DEFAULT false,
	`has_screenshot` integer DEFAULT false,
	`scraped_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `map_cache` (
	`uuid` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`domain_hash` text NOT NULL,
	`urls` text NOT NULL,
	`url_count` integer NOT NULL,
	`source` text NOT NULL,
	`discovered_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_cache_url_options_idx` ON `page_cache` (`url_hash`, `options_hash`);
--> statement-breakpoint
CREATE INDEX `page_cache_url_hash_idx` ON `page_cache` (`url_hash`);
--> statement-breakpoint
CREATE INDEX `page_cache_domain_idx` ON `page_cache` (`domain`);
--> statement-breakpoint
CREATE INDEX `page_cache_scraped_at_idx` ON `page_cache` (`scraped_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `map_cache_domain_source_idx` ON `map_cache` (`domain_hash`, `source`);
--> statement-breakpoint
CREATE INDEX `map_cache_domain_hash_idx` ON `map_cache` (`domain_hash`);
--> statement-breakpoint
CREATE INDEX `map_cache_discovered_at_idx` ON `map_cache` (`discovered_at`);
