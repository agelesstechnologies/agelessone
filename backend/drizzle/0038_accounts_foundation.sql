CREATE SCHEMA "accounts";
--> statement-breakpoint
CREATE TABLE "accounts"."journal_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."journal_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_public_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"description" text,
	"reverses_entry_id" bigint,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "journal_entries_source_unique" UNIQUE("legal_entity_id","source_type","source_public_id"),
	CONSTRAINT "journal_entries_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "journal_entries_reverses_unique" UNIQUE("reverses_entry_id"),
	CONSTRAINT "journal_entries_source_check" CHECK (source_type IN ('expense_approved','expense_paid','payroll_approved','salary_paid','reversal')),
	CONSTRAINT "journal_entries_currency_check" CHECK (currency = 'INR'),
	CONSTRAINT "journal_entries_reversal_check" CHECK ((source_type = 'reversal') = (reverses_entry_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "accounts"."journal_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."journal_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"entry_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"line_no" integer NOT NULL,
	"ledger_key" text NOT NULL,
	"debit_minor" bigint DEFAULT 0 NOT NULL,
	"credit_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	CONSTRAINT "journal_lines_entry_line_unique" UNIQUE("entry_id","line_no"),
	CONSTRAINT "journal_lines_amount_check" CHECK (debit_minor >= 0 AND credit_minor >= 0 AND (debit_minor > 0) <> (credit_minor > 0)),
	CONSTRAINT "journal_lines_currency_check" CHECK (currency = 'INR')
);
--> statement-breakpoint
CREATE TABLE "accounts"."periods" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."periods_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"closed_by" bigint,
	"closed_at" timestamp with time zone,
	"reopen_requested_by" bigint,
	"reopen_requested_at" timestamp with time zone,
	"reopen_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "periods_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "periods_company_month_unique" UNIQUE("legal_entity_id","year","month"),
	CONSTRAINT "periods_month_check" CHECK (month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2100),
	CONSTRAINT "periods_state_check" CHECK (state IN ('open','soft_closed','closed'))
);
--> statement-breakpoint
CREATE TABLE "accounts"."posting_rules" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."posting_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint,
	"event_type" text NOT NULL,
	"debit_ledger_key" text NOT NULL,
	"credit_ledger_key" text NOT NULL,
	"deduction_ledger_key" text,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_rules_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "posting_rules_version_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","legal_entity_id","event_type","version"),
	CONSTRAINT "posting_rules_event_check" CHECK (event_type IN ('expense_approved','expense_paid','payroll_approved','salary_paid')),
	CONSTRAINT "posting_rules_version_positive" CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TABLE "accounts"."tally_ledger_map" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."tally_ledger_map_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"ledger_key" text NOT NULL,
	"tally_company" text NOT NULL,
	"tally_ledger_name" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"drafted_by" bigint NOT NULL,
	"drafted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" bigint,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tally_ledger_map_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tally_ledger_map_key_unique" UNIQUE("legal_entity_id","ledger_key"),
	CONSTRAINT "tally_ledger_map_state_check" CHECK (state IN ('draft','approved')),
	CONSTRAINT "tally_ledger_map_approved_fields" CHECK ((state = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
	CONSTRAINT "tally_ledger_map_not_own_approval" CHECK (approved_by IS NULL OR approved_by <> drafted_by)
);
--> statement-breakpoint
ALTER TABLE "accounts"."journal_entries" ADD CONSTRAINT "journal_entries_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."journal_entries" ADD CONSTRAINT "journal_entries_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."journal_entries" ADD CONSTRAINT "journal_entries_reverses_fk" FOREIGN KEY ("reverses_entry_id","legal_entity_id") REFERENCES "accounts"."journal_entries"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."journal_lines" ADD CONSTRAINT "journal_lines_entry_company_fk" FOREIGN KEY ("entry_id","legal_entity_id") REFERENCES "accounts"."journal_entries"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."periods" ADD CONSTRAINT "periods_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."periods" ADD CONSTRAINT "periods_closed_by_persons_id_fk" FOREIGN KEY ("closed_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."periods" ADD CONSTRAINT "periods_reopen_requested_by_persons_id_fk" FOREIGN KEY ("reopen_requested_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."posting_rules" ADD CONSTRAINT "posting_rules_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."posting_rules" ADD CONSTRAINT "posting_rules_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_ledger_map" ADD CONSTRAINT "tally_ledger_map_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_ledger_map" ADD CONSTRAINT "tally_ledger_map_drafted_by_persons_id_fk" FOREIGN KEY ("drafted_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_ledger_map" ADD CONSTRAINT "tally_ledger_map_approved_by_persons_id_fk" FOREIGN KEY ("approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_journal_entries_date" ON "accounts"."journal_entries" USING btree ("legal_entity_id","entry_date");--> statement-breakpoint
CREATE INDEX "idx_journal_lines_ledger" ON "accounts"."journal_lines" USING btree ("legal_entity_id","ledger_key");--> statement-breakpoint
CREATE INDEX "idx_posting_rules_event" ON "accounts"."posting_rules" USING btree ("tenant_id","event_type","effective_from");--> statement-breakpoint
-- Posting rules and the journal are append-only: a change is a new version, a correction is a reversing entry.
CREATE FUNCTION "accounts"."forbid_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ACCOUNTS_APPEND_ONLY: % rows cannot be changed or deleted (% refused); add a new row (a reversal for a journal entry)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_posting_rules_append_only" BEFORE UPDATE OR DELETE ON "accounts"."posting_rules"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_journal_entries_append_only" BEFORE UPDATE OR DELETE ON "accounts"."journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_journal_lines_append_only" BEFORE UPDATE OR DELETE ON "accounts"."journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_change"();--> statement-breakpoint
-- Debits equal credits, checked when the transaction commits (so lines can be inserted one by one). At least two lines.
CREATE FUNCTION "accounts"."check_entry_balanced"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid bigint; d numeric; c numeric; n integer;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN eid := NEW.id; ELSE eid := NEW.entry_id; END IF;
  SELECT coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0), count(*) INTO d, c, n
    FROM "accounts"."journal_lines" WHERE entry_id = eid;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'ACCOUNTS_UNBALANCED: journal entry % has % lines, debits % and credits %', eid, n, d, c USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_journal_entries_balanced" AFTER INSERT ON "accounts"."journal_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "accounts"."check_entry_balanced"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_journal_lines_balanced" AFTER INSERT ON "accounts"."journal_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "accounts"."check_entry_balanced"();--> statement-breakpoint
-- Nothing is posted into a closed month.
CREATE FUNCTION "accounts"."guard_closed_period"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "accounts"."periods" p WHERE p.legal_entity_id = NEW.legal_entity_id AND p.state = 'closed'
               AND p.year = EXTRACT(YEAR FROM NEW.entry_date) AND p.month = EXTRACT(MONTH FROM NEW.entry_date)) THEN
    RAISE EXCEPTION 'ACCOUNTS_PERIOD_CLOSED: the period of % is closed', NEW.entry_date USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_journal_entries_period" BEFORE INSERT ON "accounts"."journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."guard_closed_period"();--> statement-breakpoint
-- Periods are kept for history: never deleted.
CREATE FUNCTION "accounts"."forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ACCOUNTS_NO_DELETE: % rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_periods_no_delete" BEFORE DELETE ON "accounts"."periods"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_tally_ledger_map_no_delete" BEFORE DELETE ON "accounts"."tally_ledger_map"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_delete"();--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('accounts.make',  'accounts', 'Accounts executive (maker): drafts ledger mappings, creates payment batches, marks payments paid, imports bank statements'),
  ('accounts.check', 'accounts', 'Accounts manager (checker): approves ledger mappings and batches, closes months, reverses entries; MFA required'),
  ('accounts.view',  'accounts', 'Read the Accounts screens: periods, journal entries, ledger mapping');
