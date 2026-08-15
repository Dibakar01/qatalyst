CREATE TYPE "public"."stage" AS ENUM('new', 'contacted', 'replied', 'qualified', 'customer');--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "audience_segments" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "audience_stages" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "segments" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "stage" "stage" DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "stage_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "contacts_stage_idx" ON "contacts" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "contacts_segments_idx" ON "contacts" USING gin ("segments");