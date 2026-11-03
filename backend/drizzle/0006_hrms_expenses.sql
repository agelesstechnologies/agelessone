ALTER TABLE "hrms"."expense_claims" ADD COLUMN "employment_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "receipt_path" text;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "approved_by" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "approved_amount_paise" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "rejected_by" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "payment_ref" text;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "hrms"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_approved_by_persons_id_fk" FOREIGN KEY ("approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_rejected_by_persons_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_expense_claims_person" ON "hrms"."expense_claims" USING btree (person_id);--> statement-breakpoint
CREATE INDEX "idx_expense_claims_employment" ON "hrms"."expense_claims" USING btree (employment_id);--> statement-breakpoint
ALTER TABLE "hrms"."expense_categories" ADD CONSTRAINT "expense_categories_tenant_code_unique" UNIQUE("tenant_id","code");--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_status_check" CHECK (status IN ('submitted','approved','rejected','paid'));--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_amount_positive" CHECK (amount_paise > 0);--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_not_self_approved" CHECK (approved_by IS NULL OR approved_by <> person_id);--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_not_self_rejected" CHECK (rejected_by IS NULL OR rejected_by <> person_id);--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_approved_within_claim" CHECK (approved_amount_paise IS NULL OR (approved_amount_paise > 0 AND approved_amount_paise <= amount_paise));--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_paid_has_details" CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND payment_ref IS NOT NULL));--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_rejected_has_reason" CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL);--> statement-breakpoint
-- A paid claim is final: no update or delete of a row whose status is already 'paid'.
CREATE FUNCTION "hrms"."forbid_paid_claim_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'expense claim % is paid and cannot change', OLD.public_id USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_paid_claim_frozen" BEFORE UPDATE OR DELETE ON "hrms"."expense_claims"
  FOR EACH ROW WHEN (OLD.status = 'paid') EXECUTE FUNCTION "hrms"."forbid_paid_claim_change"();--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.expenses.submit',  'hrms', 'Submit and see your own expense claims'),
  ('hrms.expenses.approve', 'hrms', 'Approve or reject expense claims (team: claims on jobs you manage)'),
  ('hrms.expenses.pay',     'hrms', 'Mark approved expense claims as paid'),
  ('hrms.expenses.report',  'hrms', 'Expense report by company and dates');