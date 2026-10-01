CREATE TABLE `sent_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`message_id` text NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`from_address` text NOT NULL,
	`to_address` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`attachments` text NOT NULL,
	`response` text,
	`error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sent_emails_message_id_uq` ON `sent_emails` (`message_id`);--> statement-breakpoint
CREATE INDEX `sent_emails_app_idx` ON `sent_emails` (`application_id`,`created_at`);