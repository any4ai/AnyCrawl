CREATE TABLE `monitor_changes` (
	`uuid` text PRIMARY KEY NOT NULL,
	`monitor_uuid` text NOT NULL,
	`url` text NOT NULL,
	`from_snapshot_uuid` text,
	`to_snapshot_uuid` text,
	`change_type` text NOT NULL,
	`diff_text` text,
	`diff_json` text,
	`judgment` text,
	`notified` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`monitor_uuid`) REFERENCES `monitors`(`uuid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `monitor_snapshots` (
	`uuid` text PRIMARY KEY NOT NULL,
	`monitor_uuid` text NOT NULL,
	`task_execution_uuid` text,
	`url` text NOT NULL,
	`content_hash` text NOT NULL,
	`content` text,
	`extracted` text,
	`status` text NOT NULL,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`monitor_uuid`) REFERENCES `monitors`(`uuid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_execution_uuid`) REFERENCES `task_executions`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `monitors` (
	`uuid` text PRIMARY KEY NOT NULL,
	`api_key_id` text,
	`user_id` text,
	`name` text NOT NULL,
	`description` text,
	`monitor_type` text DEFAULT 'webpage' NOT NULL,
	`scheduled_task_uuid` text,
	`targets` text NOT NULL,
	`goal` text,
	`track_mode` text DEFAULT 'text' NOT NULL,
	`extract_schema` text,
	`diff_options` text,
	`notify_options` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_key`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scheduled_task_uuid`) REFERENCES `scheduled_tasks`(`uuid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `billing_ledger` ADD `charge_details` text;