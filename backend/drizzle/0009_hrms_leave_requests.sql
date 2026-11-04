CREATE TABLE "hrms"."leave_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."leave_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"employment_id" bigint NOT NULL,
	"leave_type_id" bigint NOT NULL,
	"year" integer NOT NULL,
	"entry" text NOT NULL,
	"days" numeric(5, 1) NOT NULL,
	"leave_request_id" bigint,
	"reason" text,
	"posted_by" bigint NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_ledger_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "leave_ledger_entry_check" CHECK (entry IN ('opening','grant','taken','taken_reversal','adjustment')),
	CONSTRAINT "leave_ledger_days_not_zero" CHECK (days <> 0),
	CONSTRAINT "leave_ledger_taken_sign" CHECK ((entry <> 'taken' OR days < 0) AND (entry <> 'taken_reversal' OR days > 0)),
	CONSTRAINT "leave_ledger_request_link" CHECK ((entry IN ('taken','taken_reversal')) = (leave_request_id IS NOT NULL)),
	CONSTRAINT "leave_ledger_reason_required" CHECK (entry NOT IN ('opening','adjustment','grant') OR reason IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ALTER COLUMN "status" SET DEFAULT 'submitted';--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "employment_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "legal_entity_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "from_half" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "to_half" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "approver_person_id" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "decided_by" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "cancelled_by" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_types" ADD COLUMN "is_paid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD CONSTRAINT "leave_ledger_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "hrms"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD CONSTRAINT "leave_ledger_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "hrms"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD CONSTRAINT "leave_ledger_leave_request_id_leave_requests_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "hrms"."leave_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD CONSTRAINT "leave_ledger_posted_by_persons_id_fk" FOREIGN KEY ("posted_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_leave_ledger_balance" ON "hrms"."leave_ledger" USING btree ("employment_id","leave_type_id","year");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_leave_ledger_one_opening" ON "hrms"."leave_ledger" USING btree ("employment_id","leave_type_id","year") WHERE entry = 'opening';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_leave_ledger_request_entry" ON "hrms"."leave_ledger" USING btree ("leave_request_id","entry","year") WHERE leave_request_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "hrms"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_approver_person_id_persons_id_fk" FOREIGN KEY ("approver_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_decided_by_persons_id_fk" FOREIGN KEY ("decided_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_cancelled_by_persons_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_leave_requests_employment" ON "hrms"."leave_requests" USING btree ("employment_id","from_date");--> statement-breakpoint
CREATE INDEX "idx_leave_requests_approver" ON "hrms"."leave_requests" USING btree ("approver_person_id","status");--> statement-breakpoint
ALTER TABLE "hrms"."leave_types" ADD CONSTRAINT "leave_types_tenant_code_unique" UNIQUE("tenant_id","code");--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_status_check" CHECK (status IN ('draft','submitted','approved','rejected','cancelled'));--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_halves_check" CHECK (from_half IN ('full','second_half') AND to_half IN ('full','first_half'));--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_dates_check" CHECK (to_date >= from_date);--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_days_check" CHECK (days > 0);--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_not_own_decision" CHECK (decided_by IS NULL OR decided_by <> person_id);--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_not_own_approver" CHECK (approver_person_id IS NULL OR approver_person_id <> person_id);--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_decided_fields" CHECK ((status IN ('approved','rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL) OR status = 'cancelled');--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_rejected_has_reason" CHECK (status <> 'rejected' OR decision_reason IS NOT NULL);--> statement-breakpoint
-- Submitted or approved leave of the same job never overlaps (a request on another job may).
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_no_overlap"
  EXCLUDE USING gist (employment_id WITH =, daterange(from_date, to_date, '[]') WITH &&) WHERE (status IN ('submitted','approved'));--> statement-breakpoint
-- The ledger is append-only: a mistake is put right by another row (adjustment or taken_reversal).
CREATE FUNCTION "hrms"."forbid_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HRMS_LEDGER_APPEND_ONLY: leave ledger rows cannot be changed or deleted (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_leave_ledger_append_only" BEFORE UPDATE OR DELETE ON "hrms"."leave_ledger"
  FOR EACH ROW EXECUTE FUNCTION "hrms"."forbid_ledger_change"();--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.leave.apply',   'hrms', 'Apply for leave on your own jobs; see and cancel your own requests and balances'),
  ('hrms.leave.approve', 'hrms', 'Approve or reject leave (team: requests that name you as approver)'),
  ('hrms.leave.manage',  'hrms', 'Post opening balances and adjustments; cancel anyone''s approved leave'),
  ('hrms.leave.report',  'hrms', 'Leave report by company and dates (team: people you manage)');
