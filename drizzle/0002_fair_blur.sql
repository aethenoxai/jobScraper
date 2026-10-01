CREATE TABLE `job_listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`source_id` integer NOT NULL,
	`source_job_id` text NOT NULL,
	`source_url` text NOT NULL,
	`application_url` text,
	`apply_email` text,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`location` text,
	`work_mode` text,
	`employment_type` text,
	`salary_text` text,
	`description` text NOT NULL,
	`description_hash` text NOT NULL,
	`posted_at` integer,
	`expires_at` integer,
	`status` text NOT NULL,
	`missed_runs` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_changed_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_listings_source_job_uq` ON `job_listings` (`source_id`,`source_job_id`);--> statement-breakpoint
CREATE INDEX `job_listings_job_idx` ON `job_listings` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`company_key` text NOT NULL,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`location` text,
	`work_mode` text,
	`employment_type` text,
	`salary_min` real,
	`salary_max` real,
	`salary_currency` text,
	`salary_period` text,
	`status` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_fingerprint_idx` ON `jobs` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `jobs_company_idx` ON `jobs` (`company_key`);--> statement-breakpoint
CREATE INDEX `jobs_first_seen_idx` ON `jobs` (`first_seen_at`);--> statement-breakpoint
CREATE TABLE `source_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_run_id` integer,
	`source_id` integer NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`found` integer DEFAULT 0 NOT NULL,
	`new_listings` integer DEFAULT 0 NOT NULL,
	`new_jobs` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`unchanged` integer DEFAULT 0 NOT NULL,
	`expired` integer DEFAULT 0 NOT NULL,
	`parse_errors` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error` text,
	FOREIGN KEY (`scan_run_id`) REFERENCES `scan_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_runs_source_idx` ON `source_runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`adapter_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`origin` text NOT NULL,
	`last_run_at` integer,
	`last_success_at` integer,
	`last_status` text,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
