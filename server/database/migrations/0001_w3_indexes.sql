CREATE INDEX "user_invites_created_by_idx" ON "user_invites" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "user_invites_used_by_idx" ON "user_invites" USING btree ("used_by");--> statement-breakpoint
CREATE INDEX "call_participants_waiting_idx" ON "call_participants" USING btree ("requested_at") WHERE "call_participants"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "room_invites_created_by_idx" ON "room_invites" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "recordings_meeting_idx" ON "recordings" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "recordings_started_at_idx" ON "recordings" USING btree ("started_at");