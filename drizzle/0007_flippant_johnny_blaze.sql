PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`job_id` integer,
	`listing_id` integer,
	`match_id` integer,
	`job_title` text NOT NULL,
	`company` text NOT NULL,
	`location` text,
	`source_name` text NOT NULL,
	`source_url` text NOT NULL,
	`application_url` text,
	`apply_email` text,
	`method` text NOT NULL,
	`status` text NOT NULL,
	`failure_code` text,
	`failure_reason` text,
	`approved_at` integer NOT NULL,
	`submitted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`listing_id`) REFERENCES `job_listings`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_applications`("id", "profile_id", "job_id", "listing_id", "match_id", "job_title", "company", "location", "source_name", "source_url", "application_url", "apply_email", "method", "status", "failure_code", "failure_reason", "approved_at", "submitted_at", "created_at", "updated_at")
SELECT a."id", a."profile_id", a."job_id", a."listing_id", a."match_id", COALESCE(j."title", 'Unknown job'), COALESCE(j."company", 'Unknown company'), j."location", COALESCE(s."name", 'Unknown source'), COALESCE(l."source_url", ''), l."application_url", l."apply_email", a."method", a."status", a."failure_code", a."failure_reason", a."approved_at", a."submitted_at", a."created_at", a."updated_at"
FROM `applications` a LEFT JOIN `jobs` j ON j."id" = a."job_id" LEFT JOIN `job_listings` l ON l."id" = a."listing_id" LEFT JOIN `sources` s ON s."id" = l."source_id";--> statement-breakpoint
DROP TABLE `applications`;--> statement-breakpoint
ALTER TABLE `__new_applications` RENAME TO `applications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `applications_profile_listing_uq` ON `applications` (`profile_id`,`listing_id`);--> statement-breakpoint
CREATE INDEX `applications_status_idx` ON `applications` (`status`);