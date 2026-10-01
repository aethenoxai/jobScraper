CREATE TABLE `application_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`type` text NOT NULL,
	`origin` text NOT NULL,
	`message` text NOT NULL,
	`confidence` real,
	`payload` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_events_app_idx` ON `application_events` (`application_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`listing_id` integer NOT NULL,
	`match_id` integer,
	`method` text NOT NULL,
	`status` text NOT NULL,
	`failure_code` text,
	`failure_reason` text,
	`approved_at` integer NOT NULL,
	`submitted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listing_id`) REFERENCES `job_listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_profile_listing_uq` ON `applications` (`profile_id`,`listing_id`);--> statement-breakpoint
CREATE INDEX `applications_status_idx` ON `applications` (`status`);--> statement-breakpoint
CREATE TABLE `job_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`description_hash` text NOT NULL,
	`requirements` text NOT NULL,
	`method` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_analyses_description_hash_unique` ON `job_analyses` (`description_hash`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`score` integer NOT NULL,
	`breakdown` text NOT NULL,
	`decision` text NOT NULL,
	`filter_reason` text,
	`review_state` text NOT NULL,
	`method` text NOT NULL,
	`slider_value` integer NOT NULL,
	`job_version` integer NOT NULL,
	`profile_version` integer NOT NULL,
	`first_surfaced_at` integer,
	`evaluated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matches_profile_job_uq` ON `matches` (`profile_id`,`job_id`);--> statement-breakpoint
CREATE INDEX `matches_feed_idx` ON `matches` (`profile_id`,`decision`,`score`);