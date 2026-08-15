CREATE TABLE "warmups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_mailbox" text NOT NULL,
	"to_mailbox" text NOT NULL,
	"message_id_header" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "warmups_message_id_idx" ON "warmups" USING btree ("message_id_header");--> statement-breakpoint
CREATE INDEX "warmups_to_idx" ON "warmups" USING btree ("to_mailbox","replied_at");