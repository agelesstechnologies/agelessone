CREATE TABLE "tickets"."ticket_daily_updates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_daily_updates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"work_date" date NOT NULL,
	"note" text NOT NULL,
	"percent_complete" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_daily_updates_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ticket_daily_updates_one_per_day" UNIQUE("ticket_id","employment_id","work_date"),
	CONSTRAINT "ticket_daily_updates_id_ticket_unique" UNIQUE("id","ticket_id"),
	CONSTRAINT "ticket_daily_updates_percent_check" CHECK (percent_complete BETWEEN 0 AND 100),
	CONSTRAINT "ticket_daily_updates_note_length" CHECK (length(note) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "tickets"."ticket_time_adjustments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_time_adjustments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"batch_id" uuid NOT NULL,
	"ticket_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"person_id" bigint NOT NULL,
	"work_date" date NOT NULL,
	"minutes" integer NOT NULL,
	"reason" text NOT NULL,
	"adjusted_by" bigint NOT NULL,
	"adjusted_as" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_time_adjustments_batch_ticket_unique" UNIQUE("batch_id","ticket_id"),
	CONSTRAINT "ticket_time_adjustments_minutes_check" CHECK (minutes <> 0),
	CONSTRAINT "ticket_time_adjustments_reason_check" CHECK (length(trim(reason)) >= 3),
	CONSTRAINT "ticket_time_adjustments_not_own" CHECK (adjusted_by <> person_id),
	CONSTRAINT "ticket_time_adjustments_as_check" CHECK (adjusted_as IN ('head','management'))
);
--> statement-breakpoint
CREATE TABLE "tickets"."ticket_time_allocations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_time_allocations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"person_id" bigint NOT NULL,
	"work_date" date NOT NULL,
	"minutes" integer NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_time_allocations_unique" UNIQUE("ticket_id","employment_id","work_date"),
	CONSTRAINT "ticket_time_allocations_minutes_check" CHECK (minutes >= 0)
);
--> statement-breakpoint
CREATE TABLE "tickets"."ticket_timelogs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_timelogs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"ticket_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_timelogs_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ticket_timelogs_end_reason_check" CHECK (end_reason IS NULL OR end_reason IN ('manual','day_punch_out','unfinished')),
	CONSTRAINT "ticket_timelogs_end_fields" CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
	CONSTRAINT "ticket_timelogs_end_after_start" CHECK (ended_at IS NULL OR ended_at >= started_at)
);
--> statement-breakpoint
ALTER TABLE "tickets"."ticket_attachments" ADD COLUMN "daily_update_id" bigint;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_daily_updates" ADD CONSTRAINT "ticket_daily_updates_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_daily_updates" ADD CONSTRAINT "ticket_daily_updates_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_adjustments" ADD CONSTRAINT "ticket_time_adjustments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_adjustments" ADD CONSTRAINT "ticket_time_adjustments_adjusted_by_persons_id_fk" FOREIGN KEY ("adjusted_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_adjustments" ADD CONSTRAINT "ticket_time_adjustments_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_adjustments" ADD CONSTRAINT "ticket_time_adjustments_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_allocations" ADD CONSTRAINT "ticket_time_allocations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_allocations" ADD CONSTRAINT "ticket_time_allocations_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_allocations" ADD CONSTRAINT "ticket_time_allocations_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_timelogs" ADD CONSTRAINT "ticket_timelogs_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_timelogs" ADD CONSTRAINT "ticket_timelogs_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ticket_daily_updates_date" ON "tickets"."ticket_daily_updates" USING btree ("work_date");--> statement-breakpoint
CREATE INDEX "idx_ticket_time_adjustments_person_date" ON "tickets"."ticket_time_adjustments" USING btree ("person_id","work_date");--> statement-breakpoint
CREATE INDEX "idx_ticket_time_allocations_person_date" ON "tickets"."ticket_time_allocations" USING btree ("person_id","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_timelogs_one_running" ON "tickets"."ticket_timelogs" USING btree ("ticket_id","employment_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_ticket_timelogs_employment" ON "tickets"."ticket_timelogs" USING btree ("employment_id","started_at");--> statement-breakpoint
ALTER TABLE "tickets"."ticket_attachments" ADD CONSTRAINT "ticket_attachments_daily_update_fk" FOREIGN KEY ("daily_update_id","ticket_id") REFERENCES "tickets"."ticket_daily_updates"("id","ticket_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Ticket time is never edited: a timelog is only closed once (ended_at, end_reason); nothing is deleted.
CREATE FUNCTION "tickets"."guard_timelog"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
     OR (to_jsonb(NEW) - 'ended_at' - 'end_reason') <> (to_jsonb(OLD) - 'ended_at' - 'end_reason') THEN
    RAISE EXCEPTION 'TICKETS_TIME_NOT_EDITABLE: a timelog is never changed or deleted, only closed once (% refused)', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ticket_timelogs_close_only" BEFORE UPDATE OR DELETE ON "tickets"."ticket_timelogs"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."guard_timelog"();--> statement-breakpoint
CREATE TRIGGER "trg_ticket_time_adjustments_append_only" BEFORE UPDATE OR DELETE ON "tickets"."ticket_time_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_ticket_daily_updates_append_only" BEFORE UPDATE OR DELETE ON "tickets"."ticket_daily_updates"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_ticket_time_allocations_never_deleted" BEFORE DELETE ON "tickets"."ticket_time_allocations"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_delete"();--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('tickets.time.adjust', 'tickets', 'Review ticket time: move a person''s daily minutes between tickets with a reason (team: tickets of departments you head; all: every ticket). Never your own time');
