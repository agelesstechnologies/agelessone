CREATE TABLE "hrms"."attendance_corrections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."attendance_corrections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"person_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"work_date" date NOT NULL,
	"kind" text NOT NULL,
	"requested_in" timestamp with time zone,
	"requested_out" timestamp with time zone,
	"punch_ids_to_exclude" uuid[] DEFAULT '{}' NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"requested_by" bigint NOT NULL,
	"approver_person_id" bigint,
	"decided_by" bigint,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"cancelled_by" bigint,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_corrections_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "attendance_corrections_kind_check" CHECK (kind IN ('missed_out','missed_in','wrong_time','other')),
	CONSTRAINT "attendance_corrections_status_check" CHECK (status IN ('submitted','approved','rejected','cancelled')),
	CONSTRAINT "attendance_corrections_reason_length" CHECK (char_length(reason) >= 10),
	CONSTRAINT "attendance_corrections_times_order" CHECK (requested_in IS NULL OR requested_out IS NULL OR requested_in < requested_out),
	CONSTRAINT "attendance_corrections_not_own_decision" CHECK (decided_by IS NULL OR (decided_by <> person_id AND decided_by <> requested_by)),
	CONSTRAINT "attendance_corrections_not_own_approver" CHECK (approver_person_id IS NULL OR (approver_person_id <> person_id AND approver_person_id <> requested_by)),
	CONSTRAINT "attendance_corrections_rejected_has_reason" CHECK (status <> 'rejected' OR decision_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "hrms"."attendance_exclusions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."attendance_exclusions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"punch_id" bigint NOT NULL,
	"correction_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_exclusions_punch_id_unique" UNIQUE("punch_id")
);
--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD COLUMN "correction_id" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "hrms"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_requested_by_persons_id_fk" FOREIGN KEY ("requested_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_approver_person_id_persons_id_fk" FOREIGN KEY ("approver_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_decided_by_persons_id_fk" FOREIGN KEY ("decided_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_cancelled_by_persons_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_exclusions" ADD CONSTRAINT "attendance_exclusions_punch_id_attendance_events_id_fk" FOREIGN KEY ("punch_id") REFERENCES "hrms"."attendance_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_exclusions" ADD CONSTRAINT "attendance_exclusions_correction_id_attendance_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "hrms"."attendance_corrections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_correction_open_per_day" ON "hrms"."attendance_corrections" USING btree ("employment_id","work_date") WHERE status = 'submitted';--> statement-breakpoint
CREATE INDEX "idx_corrections_approver" ON "hrms"."attendance_corrections" USING btree ("approver_person_id","status");--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_correction_id_attendance_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "hrms"."attendance_corrections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_correction_link" CHECK ((source = 'correction') = (correction_id IS NOT NULL));--> statement-breakpoint
-- Exclusions are append-only, like punches.
CREATE FUNCTION "hrms"."forbid_exclusion_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HRMS_EXCLUSION_APPEND_ONLY: punch exclusions cannot be changed or deleted (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_exclusion_append_only" BEFORE UPDATE OR DELETE ON "hrms"."attendance_exclusions"
  FOR EACH ROW EXECUTE FUNCTION "hrms"."forbid_exclusion_change"();--> statement-breakpoint
-- Punch order (from 0007), now ignoring punches an approved correction left out. Correction punches skip the check.
CREATE OR REPLACE FUNCTION "hrms"."check_punch_order"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev "hrms"."attendance_events"; nxt "hrms"."attendance_events";
BEGIN
  IF NEW.source = 'correction' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(NEW.person_id);
  SELECT * INTO prev FROM "hrms"."attendance_events" e WHERE e.person_id = NEW.person_id AND e.occurred_at <= NEW.occurred_at
     AND NOT EXISTS (SELECT 1 FROM "hrms"."attendance_exclusions" x WHERE x.punch_id = e.id)
   ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1;
  SELECT * INTO nxt FROM "hrms"."attendance_events" e WHERE e.person_id = NEW.person_id AND e.occurred_at > NEW.occurred_at
     AND NOT EXISTS (SELECT 1 FROM "hrms"."attendance_exclusions" x WHERE x.punch_id = e.id)
   ORDER BY e.occurred_at ASC, e.id ASC LIMIT 1;
  IF coalesce(prev.kind, 'out') = NEW.kind THEN
    RAISE EXCEPTION 'HRMS_PUNCH_ORDER: punch % refused, the punch before it is also %', NEW.kind, coalesce(prev.kind, 'out (or none)');
  END IF;
  IF NEW.kind = 'out' AND prev.employment_id <> NEW.employment_id THEN
    RAISE EXCEPTION 'HRMS_PUNCH_ORDER: punch out refused, you are punched in on another job';
  END IF;
  IF nxt.kind = NEW.kind THEN
    RAISE EXCEPTION 'HRMS_PUNCH_ORDER: punch % refused, the punch after it is also %', NEW.kind, nxt.kind;
  END IF;
  IF NEW.kind = 'in' AND nxt.kind = 'out' AND nxt.employment_id <> NEW.employment_id THEN
    RAISE EXCEPTION 'HRMS_PUNCH_ORDER: punch in refused, the next punch out is on another job';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.attendance.approve', 'hrms', 'Approve or reject attendance corrections (team: corrections that name you as approver)');
