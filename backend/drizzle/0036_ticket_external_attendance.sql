-- The attendance foreign key needs this key first (drizzle-kit wrote it last).
ALTER TABLE "tickets"."ticket_external_staff" ADD CONSTRAINT "ticket_external_staff_id_ticket_company_unique" UNIQUE("id","ticket_id","legal_entity_id");--> statement-breakpoint
CREATE TABLE "tickets"."ticket_external_attendance" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_external_attendance_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"external_staff_id" bigint NOT NULL,
	"work_date" date NOT NULL,
	"status" text NOT NULL,
	"time_in" timestamp with time zone,
	"time_out" timestamp with time zone,
	"note" text,
	"recorded_by" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone,
	CONSTRAINT "ticket_external_attendance_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ticket_external_attendance_one_per_day" UNIQUE("external_staff_id","work_date"),
	CONSTRAINT "ticket_external_attendance_status_check" CHECK (status IN ('present','half_day','absent')),
	CONSTRAINT "ticket_external_attendance_absent_no_times" CHECK (status <> 'absent' OR (time_in IS NULL AND time_out IS NULL)),
	CONSTRAINT "ticket_external_attendance_out_after_in" CHECK (time_in IS NULL OR time_out IS NULL OR time_out > time_in),
	CONSTRAINT "ticket_external_attendance_note_length" CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 200),
	CONSTRAINT "ticket_external_attendance_updated_fields" CHECK ((updated_by IS NULL) = (updated_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "tickets"."ticket_external_attendance" ADD CONSTRAINT "ticket_external_attendance_recorded_by_persons_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_external_attendance" ADD CONSTRAINT "ticket_external_attendance_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_external_attendance" ADD CONSTRAINT "ticket_external_attendance_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_external_attendance" ADD CONSTRAINT "ticket_external_attendance_staff_company_fk" FOREIGN KEY ("external_staff_id","ticket_id","legal_entity_id") REFERENCES "tickets"."ticket_external_staff"("id","ticket_id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ticket_external_attendance_ticket_date" ON "tickets"."ticket_external_attendance" USING btree ("ticket_id","work_date");