CREATE TABLE "core"."notification_preferences" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."notification_preferences_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"person_id" bigint NOT NULL,
	"alert_code" text NOT NULL,
	"email" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_unique" UNIQUE("person_id","alert_code"),
	CONSTRAINT "notification_preferences_alert_code_format" CHECK (alert_code ~ '^[a-z]+([.][a-z_]+)+$')
);
--> statement-breakpoint
CREATE TABLE "core"."notification_settings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."notification_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"person_id" bigint NOT NULL,
	"email_urgent" boolean DEFAULT true NOT NULL,
	"email_digest" boolean DEFAULT true NOT NULL,
	"quiet_start" varchar(5),
	"quiet_end" varchar(5),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_settings_person_id_unique" UNIQUE("person_id"),
	CONSTRAINT "notification_settings_quiet_check" CHECK ((quiet_start IS NULL) = (quiet_end IS NULL)),
	CONSTRAINT "notification_settings_quiet_format" CHECK ((quiet_start IS NULL OR quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND (quiet_end IS NULL OR quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
);
--> statement-breakpoint
ALTER TABLE "core"."notification_deliveries" DROP CONSTRAINT "notification_deliveries_status_check";--> statement-breakpoint
ALTER TABLE "core"."notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notification_preferences" ADD CONSTRAINT "notification_preferences_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notification_settings" ADD CONSTRAINT "notification_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notification_settings" ADD CONSTRAINT "notification_settings_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_status_check" CHECK (status IN ('pending','sent','failed','skipped'));