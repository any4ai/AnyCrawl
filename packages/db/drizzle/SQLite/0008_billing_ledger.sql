CREATE TABLE `billing_ledger` (
	`uuid` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`api_key_id` text,
	`mode` text NOT NULL,
	`reason` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`charged` integer NOT NULL,
	`before_used` integer NOT NULL,
	`after_used` integer NOT NULL,
	`before_credits` integer,
	`after_credits` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_key`(`uuid`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `billing_ledger_idempotency_key_unique` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `billing_ledger_job_id_idx` ON `billing_ledger` (`job_id`);
--> statement-breakpoint
CREATE INDEX `billing_ledger_api_key_id_idx` ON `billing_ledger` (`api_key_id`);
--> statement-breakpoint
CREATE INDEX `billing_ledger_created_at_idx` ON `billing_ledger` (`created_at`);
