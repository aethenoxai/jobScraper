CREATE TABLE `inbox_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer,
	`mailbox` text NOT NULL,
	`uid` integer NOT NULL,
	`message_id` text,
	`from_address` text,
	`subject` text,
	`received_at` integer,
	`snippet` text,
	`matched_by` text,
	`label` text,
	`confidence` real,
	`suggested_status` text,
	`resolution` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_messages_mailbox_uid_uq` ON `inbox_messages` (`mailbox`,`uid`);--> statement-breakpoint
CREATE INDEX `inbox_messages_app_idx` ON `inbox_messages` (`application_id`);