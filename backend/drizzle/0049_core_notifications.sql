CREATE TABLE "core"."notification_deliveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."notification_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"notification_id" bigint NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_channel_unique" UNIQUE("notification_id","channel"),
	CONSTRAINT "notification_deliveries_channel_check" CHECK (channel IN ('in_app','email','whatsapp')),
	CONSTRAINT "notification_deliveries_status_check" CHECK (status IN ('pending','sent','failed'))
);
--> statement-breakpoint
CREATE TABLE "core"."notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" bigint,
	"recipient_person_id" bigint NOT NULL,
	"alert_code" text NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "notifications_dedupe_unique" UNIQUE("tenant_id","recipient_person_id","dedupe_key"),
	CONSTRAINT "notifications_urgency_check" CHECK (urgency IN ('normal','urgent')),
	CONSTRAINT "notifications_alert_code_format" CHECK (alert_code ~ '^[a-z]+([.][a-z_]+)+$')
);
--> statement-breakpoint
ALTER TABLE "core"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "core"."notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notifications" ADD CONSTRAINT "notifications_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notifications" ADD CONSTRAINT "notifications_recipient_person_id_persons_id_fk" FOREIGN KEY ("recipient_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_pending" ON "core"."notification_deliveries" USING btree ("channel","id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_notifications_recipient" ON "core"."notifications" USING btree ("recipient_person_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_unread" ON "core"."notifications" USING btree ("recipient_person_id") WHERE read_at IS NULL;