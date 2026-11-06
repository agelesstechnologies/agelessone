-- Every table that points at an employment also records the employment's company, and the pair must match
-- (composite foreign key), so no row can link to another company's job. Written by hand in this order so existing rows
-- are filled before the columns become NOT NULL.
ALTER TABLE "hrms"."employments" ADD CONSTRAINT "employments_id_company_unique" UNIQUE("id","legal_entity_id");--> statement-breakpoint
ALTER TABLE "hrms"."weekly_off_rules" DROP CONSTRAINT "weekly_off_rules_one_target";--> statement-breakpoint
ALTER TABLE "hrms"."weekly_off_rules" DROP CONSTRAINT "weekly_off_rules_company_no_overlap";--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" DROP CONSTRAINT "attendance_corrections_employment_id_employments_id_fk";--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" DROP CONSTRAINT "attendance_events_employment_id_employments_id_fk";--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" DROP CONSTRAINT "overtime_requests_employment_id_employments_id_fk";--> statement-breakpoint
ALTER TABLE "hrms"."work_days" DROP CONSTRAINT "work_days_employment_id_employments_id_fk";--> statement-breakpoint
ALTER TABLE "hrms"."weekly_off_rules" DROP CONSTRAINT "weekly_off_rules_employment_id_employments_id_fk";--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" DROP CONSTRAINT "expense_claims_employment_id_employments_id_fk";--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" DROP CONSTRAINT "leave_ledger_employment_id_employments_id_fk";--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" DROP CONSTRAINT "leave_requests_employment_id_employments_id_fk";--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD COLUMN "legal_entity_id" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD COLUMN "legal_entity_id" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "legal_entity_id" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "currency" char(3) DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD COLUMN "legal_entity_id" bigint;--> statement-breakpoint
-- Fill the company from the employment. Append-only, locked-day and paid-claim triggers are paused for this copy only.
ALTER TABLE "hrms"."attendance_events" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "hrms"."attendance_events" x SET "legal_entity_id" = e."legal_entity_id" FROM "hrms"."employments" e WHERE e."id" = x."employment_id";--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "hrms"."work_days" x SET "legal_entity_id" = e."legal_entity_id" FROM "hrms"."employments" e WHERE e."id" = x."employment_id";--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "hrms"."expense_claims" x SET "legal_entity_id" = e."legal_entity_id" FROM "hrms"."employments" e WHERE e."id" = x."employment_id";--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "hrms"."leave_ledger" x SET "legal_entity_id" = e."legal_entity_id" FROM "hrms"."employments" e WHERE e."id" = x."employment_id";--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ENABLE TRIGGER USER;--> statement-breakpoint
-- A person's weekly-off override now also records the company of its job (the company default has no employment).
UPDATE "hrms"."weekly_off_rules" x SET "legal_entity_id" = e."legal_entity_id" FROM "hrms"."employments" e WHERE e."id" = x."employment_id";--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ALTER COLUMN "legal_entity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ALTER COLUMN "legal_entity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ALTER COLUMN "legal_entity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ALTER COLUMN "legal_entity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."weekly_off_rules" ALTER COLUMN "legal_entity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD CONSTRAINT "work_days_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD CONSTRAINT "leave_ledger_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD CONSTRAINT "work_days_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD CONSTRAINT "leave_ledger_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."weekly_off_rules" ADD CONSTRAINT "weekly_off_rules_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Company defaults (no employment) of one company still never overlap; person overrides keep their own rule (0008).
ALTER TABLE "hrms"."weekly_off_rules" ADD CONSTRAINT "weekly_off_rules_company_no_overlap"
  EXCLUDE USING gist (legal_entity_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&) WHERE (employment_id IS NULL);
