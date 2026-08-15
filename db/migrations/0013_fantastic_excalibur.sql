ALTER TABLE "domains" ADD COLUMN "spam_ratio" integer;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "reputation" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "stats_at" timestamp with time zone;