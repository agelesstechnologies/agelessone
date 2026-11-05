CREATE SCHEMA "payroll";
--> statement-breakpoint
CREATE TABLE "payroll"."bank_accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payroll"."bank_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"account_holder" text NOT NULL,
	"account_number" text NOT NULL,
	"ifsc" text NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "bank_accounts_employment_from_unique" UNIQUE("employment_id","effective_from"),
	CONSTRAINT "bank_accounts_number_format" CHECK (account_number ~ '^[0-9]{6,18}$'),
	CONSTRAINT "bank_accounts_ifsc_format" CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "payroll"."payroll_adjustments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payroll"."payroll_adjustments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"item_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"note" text,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_adjustments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payroll_adjustments_kind_check" CHECK (kind IN ('addition','deduction')),
	CONSTRAINT "payroll_adjustments_amount_positive" CHECK (amount_paise > 0)
);
--> statement-breakpoint
CREATE TABLE "payroll"."payroll_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payroll"."payroll_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"run_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"monthly_salary_paise" bigint NOT NULL,
	"days_in_month" integer NOT NULL,
	"employed_days" integer NOT NULL,
	"absent_days" numeric(4, 1) NOT NULL,
	"lop_amount_paise" bigint NOT NULL,
	"salary_for_month_paise" bigint NOT NULL,
	"additions_total_paise" bigint DEFAULT 0 NOT NULL,
	"deductions_total_paise" bigint DEFAULT 0 NOT NULL,
	"net_pay_paise" bigint NOT NULL,
	CONSTRAINT "payroll_items_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payroll_items_run_employment_unique" UNIQUE("run_id","employment_id"),
	CONSTRAINT "payroll_items_amounts_check" CHECK (monthly_salary_paise > 0 AND lop_amount_paise >= 0 AND salary_for_month_paise >= 0
    AND additions_total_paise >= 0 AND deductions_total_paise >= 0 AND absent_days >= 0),
	CONSTRAINT "payroll_items_net_check" CHECK (net_pay_paise = salary_for_month_paise + additions_total_paise - deductions_total_paise AND net_pay_paise >= 0)
);
--> statement-breakpoint
CREATE TABLE "payroll"."payroll_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payroll"."payroll_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"prepared_by" bigint NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" bigint,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"bank_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payroll_runs_company_month_unique" UNIQUE("legal_entity_id","year","month"),
	CONSTRAINT "payroll_runs_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "payroll_runs_month_check" CHECK (month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2100),
	CONSTRAINT "payroll_runs_status_check" CHECK (status IN ('draft','approved','paid')),
	CONSTRAINT "payroll_runs_not_own_approval" CHECK (approved_by IS NULL OR approved_by <> prepared_by),
	CONSTRAINT "payroll_runs_approved_fields" CHECK ((status = 'draft') = (approved_by IS NULL AND approved_at IS NULL)),
	CONSTRAINT "payroll_runs_paid_fields" CHECK ((status = 'paid') = (paid_at IS NOT NULL AND bank_ref IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payroll"."salaries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payroll"."salaries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"monthly_amount_paise" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"effective_from" date NOT NULL,
	"note" text,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salaries_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "salaries_employment_from_unique" UNIQUE("employment_id","effective_from"),
	CONSTRAINT "salaries_amount_positive" CHECK (monthly_amount_paise > 0)
);
--> statement-breakpoint
ALTER TABLE "payroll"."bank_accounts" ADD CONSTRAINT "bank_accounts_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."bank_accounts" ADD CONSTRAINT "bank_accounts_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."bank_accounts" ADD CONSTRAINT "bank_accounts_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_item_id_payroll_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "payroll"."payroll_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."payroll_items" ADD CONSTRAINT "payroll_items_run_company_fk" FOREIGN KEY ("run_id","legal_entity_id") REFERENCES "payroll"."payroll_runs"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."payroll_items" ADD CONSTRAINT "payroll_items_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."payroll_runs" ADD CONSTRAINT "payroll_runs_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."payroll_runs" ADD CONSTRAINT "payroll_runs_prepared_by_persons_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_persons_id_fk" FOREIGN KEY ("approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."salaries" ADD CONSTRAINT "salaries_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."salaries" ADD CONSTRAINT "salaries_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll"."salaries" ADD CONSTRAINT "salaries_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_payroll_adjustments_item" ON "payroll"."payroll_adjustments" USING btree ("item_id");--> statement-breakpoint
-- Salaries and bank details are append-only: a change is a new row from a new date.
CREATE FUNCTION "payroll"."forbid_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PAYROLL_APPEND_ONLY: % rows cannot be changed or deleted (% refused); add a new row from a new date', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_salaries_append_only" BEFORE UPDATE OR DELETE ON "payroll"."salaries"
  FOR EACH ROW EXECUTE FUNCTION "payroll"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_bank_accounts_append_only" BEFORE UPDATE OR DELETE ON "payroll"."bank_accounts"
  FOR EACH ROW EXECUTE FUNCTION "payroll"."forbid_change"();--> statement-breakpoint
-- A run's pay lines and adjustments change only while the run is a draft.
CREATE FUNCTION "payroll"."guard_draft_item"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM "payroll"."payroll_runs" WHERE id = coalesce(NEW.run_id, OLD.run_id);
  IF st <> 'draft' THEN
    RAISE EXCEPTION 'PAYROLL_RUN_FROZEN: the payroll run is % and cannot change', st USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_payroll_items_draft" BEFORE INSERT OR UPDATE OR DELETE ON "payroll"."payroll_items"
  FOR EACH ROW EXECUTE FUNCTION "payroll"."guard_draft_item"();--> statement-breakpoint
CREATE FUNCTION "payroll"."guard_draft_adjustment"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT r.status INTO st FROM "payroll"."payroll_items" i JOIN "payroll"."payroll_runs" r ON r.id = i.run_id
   WHERE i.id = coalesce(NEW.item_id, OLD.item_id);
  IF st <> 'draft' THEN
    RAISE EXCEPTION 'PAYROLL_RUN_FROZEN: the payroll run is % and cannot change', st USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_payroll_adjustments_draft" BEFORE INSERT OR UPDATE OR DELETE ON "payroll"."payroll_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "payroll"."guard_draft_adjustment"();--> statement-breakpoint
-- An approved run only moves to paid (with paid_at and bank_ref); a paid run never changes; only a draft is deleted.
CREATE FUNCTION "payroll"."guard_run"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'PAYROLL_RUN_FROZEN: an % run cannot be deleted', OLD.status USING ERRCODE = 'restrict_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'paid' OR (OLD.status = 'approved' AND (NEW.status <> 'paid'
      OR (NEW.legal_entity_id, NEW.year, NEW.month, NEW.prepared_by, NEW.prepared_at, NEW.approved_by, NEW.approved_at, NEW.currency)
         IS DISTINCT FROM (OLD.legal_entity_id, OLD.year, OLD.month, OLD.prepared_by, OLD.prepared_at, OLD.approved_by, OLD.approved_at, OLD.currency))) THEN
    RAISE EXCEPTION 'PAYROLL_RUN_FROZEN: the payroll run is % and cannot change', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_payroll_runs_frozen" BEFORE UPDATE OR DELETE ON "payroll"."payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION "payroll"."guard_run"();--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('payroll.prepare',     'payroll', 'Salaries, bank details and payroll runs: prepare, adjust, mark paid; see them and their files'),
  ('payroll.approve',     'payroll', 'Approve a payroll run prepared by someone else; see salaries and runs'),
  ('payroll.payslip.own', 'payroll', 'See and download your own payslips');
