CREATE TABLE "core"."places" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."places_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"latitude" numeric(9, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"accuracy_m" integer,
	"address" text,
	"status" text NOT NULL,
	"provider" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "places_status_check" CHECK (status IN ('resolved','pending','failed')),
	CONSTRAINT "places_resolved_fields" CHECK ((status = 'resolved') = (address IS NOT NULL AND resolved_at IS NOT NULL)),
	CONSTRAINT "places_coordinates_check" CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180),
	CONSTRAINT "places_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD COLUMN "place_id" bigint;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_timelogs" ADD COLUMN "place_id" bigint;--> statement-breakpoint
ALTER TABLE "core"."places" ADD CONSTRAINT "places_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_places_pending" ON "core"."places" USING btree ("status") WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "core"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_timelogs" ADD CONSTRAINT "ticket_timelogs_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "core"."places"("id") ON DELETE no action ON UPDATE no action;