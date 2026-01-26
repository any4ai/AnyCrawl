ALTER TABLE `jobs` ADD `traffic_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `traffic_request_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `traffic_response_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `traffic_request_count` integer DEFAULT 0 NOT NULL;