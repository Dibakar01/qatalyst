CREATE INDEX "messages_status_idx" ON "messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "messages_mailbox_sent_idx" ON "messages" USING btree ("mailbox_id","sent_at");