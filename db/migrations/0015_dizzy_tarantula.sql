ALTER TABLE "conversions" DROP CONSTRAINT "conversions_contact_event_key";--> statement-breakpoint
ALTER TABLE "conversions" ALTER COLUMN "event_id" SET DEFAULT '';--> statement-breakpoint
-- SET DEFAULT does not backfill; rows written before this column existed still
-- hold NULL, and SET NOT NULL refuses them. Empty string is the same "no id"
-- those rows already meant.
UPDATE "conversions" SET "event_id" = '' WHERE "event_id" IS NULL;--> statement-breakpoint
ALTER TABLE "conversions" ALTER COLUMN "event_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversions_contact_event_key" ON "conversions" USING btree ("contact_id","event","event_id");