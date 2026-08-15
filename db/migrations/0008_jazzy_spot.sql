ALTER TABLE "messages" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "next_attempt_at" timestamp with time zone;