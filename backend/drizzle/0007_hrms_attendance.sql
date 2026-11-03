ALTER TABLE "hrms"."work_days" DROP CONSTRAINT "work_days_person_id_work_date_unique";--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD COLUMN "employment_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD COLUMN "employment_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD COLUMN "first_in" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD COLUMN "last_out" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "hrms"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD CONSTRAINT "work_days_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "hrms"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_att_person_time" ON "hrms"."attendance_events" USING btree (person_id,occurred_at);--> statement-breakpoint
CREATE INDEX "idx_att_employment_time" ON "hrms"."attendance_events" USING btree (employment_id,occurred_at);--> statement-breakpoint
CREATE INDEX "idx_work_days_person_date" ON "hrms"."work_days" USING btree ("person_id","work_date");--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD CONSTRAINT "work_days_employment_date_unique" UNIQUE("employment_id","work_date");--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_kind_check" CHECK (kind IN ('in','out'));--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_source_check" CHECK (source IN ('app','web','supervisor','park_counter','gate','correction'));--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_location_status_check" CHECK (location_status IS NULL OR location_status IN ('inside','outside','poor_accuracy','not_configured','not_taken'));--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_lat_lng_together" CHECK ((latitude IS NULL) = (longitude IS NULL));--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_accuracy_check" CHECK (accuracy_m IS NULL OR accuracy_m >= 0);--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD CONSTRAINT "work_days_status_check" CHECK (day_status IN ('present','half_day','absent','leave','holiday','weekly_off','missed_punch'));--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD CONSTRAINT "work_days_minutes_check" CHECK (worked_minutes BETWEEN 0 AND 1440 AND overtime_minutes >= 0 AND overtime_minutes <= worked_minutes);--> statement-breakpoint
-- Punches are append-only: corrections add rows, they never edit or delete one.
CREATE FUNCTION "hrms"."forbid_punch_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HRMS_PUNCH_APPEND_ONLY: punches cannot be changed or deleted (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_punch_append_only" BEFORE UPDATE OR DELETE ON "hrms"."attendance_events"
  FOR EACH ROW EXECUTE FUNCTION "hrms"."forbid_punch_change"();--> statement-breakpoint
-- 'in' and 'out' alternate per PERSON across all their jobs; an 'out' closes the 'in' of the same job.
-- A late (offline) punch is checked against the punch before AND after it in time.
CREATE FUNCTION "hrms"."check_punch_order"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev "hrms"."attendance_events"; nxt "hrms"."attendance_events";
BEGIN
  IF NEW.source = 'correction' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(NEW.person_id);
  SELECT * INTO prev FROM "hrms"."attendance_events" WHERE person_id = NEW.person_id AND occurred_at <= NEW.occurred_at
   ORDER BY occurred_at DESC, id DESC LIMIT 1;
  SELECT * INTO nxt FROM "hrms"."attendance_events" WHERE person_id = NEW.person_id AND occurred_at > NEW.occurred_at
   ORDER BY occurred_at ASC, id ASC LIMIT 1;
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
CREATE TRIGGER "trg_punch_order" BEFORE INSERT ON "hrms"."attendance_events"
  FOR EACH ROW EXECUTE FUNCTION "hrms"."check_punch_order"();--> statement-breakpoint
-- A work day locked for payroll never changes (not even to unlock it).
CREATE FUNCTION "hrms"."guard_locked_day"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.locked_for_payroll THEN
    RAISE EXCEPTION 'HRMS_DAY_LOCKED: work day % is locked for payroll', OLD.work_date USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_locked_day" BEFORE UPDATE OR DELETE ON "hrms"."work_days"
  FOR EACH ROW EXECUTE FUNCTION "hrms"."guard_locked_day"();--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.attendance.punch',   'hrms', 'Punch in and out on your own jobs; see your own today and history'),
  ('hrms.attendance.view',    'hrms', 'Daily register and work hours (team: people you manage)'),
  ('hrms.attendance.rebuild', 'hrms', 'Recalculate work days from punches');