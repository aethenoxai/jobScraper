CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event` text NOT NULL,
	`entity_key` text NOT NULL,
	`channel` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`link` text,
	`payload` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`read_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_uq` ON `notifications` (`event`,`entity_key`,`channel`);--> statement-breakpoint
CREATE INDEX `notifications_inbox_idx` ON `notifications` (`channel`,`created_at`);