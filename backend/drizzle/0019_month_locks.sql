CREATE TABLE "hrms"."month_locks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."month_locks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"locked_by" bigint NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlocked_by" bigint,
	"unlocked_at" timestamp with time zone,
	"unlock_reason" text,
	CONSTRAINT "month_locks_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "month_locks_month_check" CHECK (month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2100),
	CONSTRAINT "month_locks_unlock_together" CHECK ((unlocked_by IS NULL) = (unlocked_at IS NULL) AND (unlocked_by IS NULL) = (unlock_reason IS NULL))
);
--> statement-breakpoint
ALTER TABLE "hrms"."month_locks" ADD CONSTRAINT "month_locks_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."month_locks" ADD CONSTRAINT "month_locks_locked_by_persons_id_fk" FOREIGN KEY ("locked_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."month_locks" ADD CONSTRAINT "month_locks_unlocked_by_persons_id_fk" FOREIGN KEY ("unlocked_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_month_lock_open" ON "hrms"."month_locks" USING btree ("legal_entity_id","year","month") WHERE unlocked_at IS NULL;--> statement-breakpoint
-- No punch and no new work day in a company's locked month (dates are IST). The services refuse first with
-- HRMS_MONTH_LOCKED; these triggers make sure nothing slips past them.
CREATE FUNCTION "hrms"."month_is_locked"(company bigint, d date) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "hrms"."month_locks" m WHERE m.legal_entity_id = company
    AND m.year = extract(year FROM d) AND m.month = extract(month FROM d) AND m.unlocked_at IS NULL)
$$;--> statement-breakpoint
CREATE FUNCTION "hrms"."guard_locked_month_punch"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date := (NEW.occurred_at AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF "hrms"."month_is_locked"(NEW.legal_entity_id, d) THEN
    RAISE EXCEPTION 'HRMS_MONTH_LOCKED: % is locked for payroll', to_char(d, 'YYYY-MM') USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_punch_month_lock" BEFORE INSERT ON "hrms"."attendance_events"
  FOR EACH ROW EXECUTE FUNCTION "hrms"."guard_locked_month_punch"();--> statement-breakpoint
CREATE FUNCTION "hrms"."guard_locked_month_day"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF "hrms"."month_is_locked"(NEW.legal_entity_id, NEW.work_date) THEN
    RAISE EXCEPTION 'HRMS_MONTH_LOCKED: % is locked for payroll', to_char(NEW.work_date, 'YYYY-MM') USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_work_day_month_lock" BEFORE INSERT ON "hrms"."work_days"
  FOR EACH ROW EXECUTE FUNCTION "hrms"."guard_locked_month_day"();--> statement-breakpoint
-- A locked work day never changes (0007) — except inside a System Admin's month unlock, which sets
-- hrms.month_unlock = 'on' for its own transaction only.
CREATE OR REPLACE FUNCTION "hrms"."guard_locked_day"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.locked_for_payroll AND coalesce(current_setting('hrms.month_unlock', true), '') <> 'on' THEN
    RAISE EXCEPTION 'HRMS_DAY_LOCKED: work day % is locked for payroll', OLD.work_date USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.month.lock',   'hrms', 'Lock a company''s month for payroll'),
  ('hrms.month.unlock', 'hrms', 'Unlock a locked month (with a reason)');
