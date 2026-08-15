DROP INDEX "conversions_contact_event_key";--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "destination_url" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "event_id" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_contact_event_key" UNIQUE NULLS NOT DISTINCT("contact_id","event","event_id");