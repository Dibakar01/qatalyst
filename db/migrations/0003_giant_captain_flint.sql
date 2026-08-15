CREATE TYPE "public"."campaign_kind" AS ENUM('outbound', 'response');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('email');--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"window_start" integer DEFAULT 540 NOT NULL,
	"window_end" integer DEFAULT 1020 NOT NULL,
	"bounce_threshold" integer DEFAULT 300 NOT NULL,
	"bounce_minimum" integer DEFAULT 20 NOT NULL,
	"catch_all_cap" integer DEFAULT 10 NOT NULL,
	"draft_batch" integer DEFAULT 25 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "channel" "channel" DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "kind" "campaign_kind" DEFAULT 'outbound' NOT NULL;