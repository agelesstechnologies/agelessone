CREATE TABLE "core"."audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_person_id" bigint,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_public_id" uuid,
	"subject_person_id" bigint,
	"legal_entity_id" bigint,
	"summary" text NOT NULL,
	"details" jsonb,
	CONSTRAINT "audit_log_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "hrms"."person_private" (
	"person_id" bigint PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"aadhaar" text,
	"pan" text,
	"updated_by" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_private_aadhaar_format" CHECK (aadhaar IS NULL OR aadhaar ~ '^[0-9]{12}$'),
	CONSTRAINT "person_private_pan_format" CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
);
--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" DROP CONSTRAINT "leave_requests_decided_fields";--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD COLUMN "decided_as" text;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD COLUMN "decided_as" text;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "decided_as" text;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "decided_as" text;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD CONSTRAINT "audit_log_actor_person_id_persons_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD CONSTRAINT "audit_log_subject_person_id_persons_id_fk" FOREIGN KEY ("subject_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD CONSTRAINT "audit_log_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."person_private" ADD CONSTRAINT "person_private_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."person_private" ADD CONSTRAINT "person_private_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_log_tenant_at" ON "core"."audit_log" USING btree ("tenant_id","at");--> statement-breakpoint
-- Decisions made before this migration were made by the named approver (or HR): record them as such before the checks apply.
UPDATE "hrms"."leave_requests" SET "decided_as" = 'approver' WHERE "decided_by" IS NOT NULL;--> statement-breakpoint
UPDATE "hrms"."attendance_corrections" SET "decided_as" = 'approver' WHERE "decided_by" IS NOT NULL;--> statement-breakpoint
UPDATE "hrms"."overtime_requests" SET "decided_as" = 'approver' WHERE "decided_by" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "hrms"."expense_claims" SET "decided_as" = 'approver' WHERE "approved_by" IS NOT NULL OR "rejected_by" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_decided_fields" CHECK (status NOT IN ('approved','rejected') OR (decided_at IS NOT NULL AND decided_as IS NOT NULL));--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_decided_as_check" CHECK (decided_as IS NULL OR decided_as IN ('approver','hr','management','no_approval_required'));--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_decider_required" CHECK (decided_as IS NULL OR (decided_as = 'no_approval_required') = (decided_by IS NULL));--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_decided_fields" CHECK (status NOT IN ('approved','rejected') OR (decided_at IS NOT NULL AND decided_as IS NOT NULL));--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_decided_as_check" CHECK (decided_as IS NULL OR decided_as IN ('approver','hr','management','no_approval_required'));--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_decider_required" CHECK (decided_as IS NULL OR (decided_as = 'no_approval_required') = (decided_by IS NULL));--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_decided_fields" CHECK ((status NOT IN ('approved','paid') OR (approved_at IS NOT NULL AND decided_as IS NOT NULL))
    AND (status <> 'rejected' OR (rejected_by IS NOT NULL AND decided_as IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_decided_as_check" CHECK (decided_as IS NULL OR decided_as IN ('approver','hr','management','no_approval_required'));--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_decider_required" CHECK (decided_as IS NULL OR (decided_as = 'no_approval_required') = (approved_by IS NULL AND rejected_by IS NULL));--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_decided_as_check" CHECK (decided_as IS NULL OR decided_as IN ('approver','hr','management','no_approval_required'));--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_decider_required" CHECK (decided_as IS NULL OR (decided_as = 'no_approval_required') = (decided_by IS NULL));--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_decided_fields" CHECK (status = 'cancelled' OR (status IN ('approved','rejected')) = (decided_at IS NOT NULL AND decided_as IS NOT NULL));--> statement-breakpoint
-- The audit log is append-only.
CREATE FUNCTION "core"."forbid_audit_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CORE_AUDIT_APPEND_ONLY: audit entries cannot be changed or deleted (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_audit_log_append_only" BEFORE UPDATE OR DELETE ON "core"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "core"."forbid_audit_change"();--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.management',     'hrms', 'Management: read every HRMS record (and payroll) in the companies of the scope'),
  ('hrms.private.view',   'hrms', 'See private details (Aadhaar, PAN, bank) masked'),
  ('hrms.private.reveal', 'hrms', 'Reveal private details in full (each reveal is audited)'),
  ('hrms.private.manage', 'hrms', 'Enter or change private details (Aadhaar, PAN)'),
  ('hrms.dashboard.view', 'hrms', 'HRMS dashboard (team: people you manage; all: every company)');
