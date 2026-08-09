CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'ready', 'sending', 'done');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('none', 'opted_in');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('unverified', 'verified', 'catch_all', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('sent', 'bounce', 'reply', 'unsubscribe', 'complaint');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('draft', 'flagged', 'approved', 'sent', 'bounced', 'replied');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('unsubscribed', 'bounced', 'complained', 'customer', 'competitor', 'manual');--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"subject_template" text DEFAULT '' NOT NULL,
	"body_template" text DEFAULT '' NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"email_status" "email_status" DEFAULT 'unverified' NOT NULL,
	"company" text,
	"title" text,
	"linkedin_url" text,
	"source" text,
	"consent_status" "consent_status" DEFAULT 'none' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"message_id" uuid,
	"type" "event_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"daily_cap" integer DEFAULT 35 NOT NULL,
	"sends_catch_all" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "mailboxes_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" "message_status" DEFAULT 'draft' NOT NULL,
	"validator_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mailbox_id" uuid,
	"message_id_header" text,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_hash" text,
	"domain" text,
	"reason" "suppression_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_lower_key" ON "contacts" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_linkedin_url_key" ON "contacts" USING btree ("linkedin_url");--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company");--> statement-breakpoint
CREATE INDEX "events_contact_idx" ON "events" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_campaign_contact_key" ON "messages" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE INDEX "messages_message_id_header_idx" ON "messages" USING btree ("message_id_header");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_email_hash_key" ON "suppressions" USING btree ("email_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_domain_key" ON "suppressions" USING btree ("domain");