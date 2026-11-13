-- Accounts: the Tally company per legal entity, and a fixed list of ledger keys. Nothing is deleted and no journal line,
-- posting rule or approved mapping is rewritten: rows written before the key rule are kept as they are (NOT VALID checks).

-- 1. The fixed list of ledger keys, in one place. A later migration replaces this function to add a key (CA TO CONFIRM the list).
-- Keep it equal to LEDGER_KEYS in shared/src/accounts.ts (a test compares them).
CREATE FUNCTION "accounts"."is_ledger_key"(k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT k = ANY (ARRAY['salary.expense', 'payable.salary', 'payable.reimbursements', 'payable.vendors',
    'stat.pf', 'stat.esi', 'stat.pt', 'stat.tds', 'asset.staff_advance', 'tax.input_cgst', 'tax.input_sgst', 'tax.input_igst',
    'expense.fuel', 'expense.travel', 'expense.food', 'expense.materials', 'expense.other', 'bank.salary', 'bank.operating', 'round_off'])
$$;--> statement-breakpoint

-- 2. One Tally company per legal entity.
CREATE TABLE "accounts"."tally_companies" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."tally_companies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"tally_company_name" text NOT NULL,
	"books_from" date NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"drafted_by" bigint NOT NULL,
	"drafted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" bigint,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tally_companies_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tally_companies_legal_entity_id_unique" UNIQUE("legal_entity_id"),
	CONSTRAINT "tally_companies_state_check" CHECK (state IN ('draft','approved')),
	CONSTRAINT "tally_companies_approved_fields" CHECK ((state = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
	CONSTRAINT "tally_companies_not_own_approval" CHECK (approved_by IS NULL OR approved_by <> drafted_by),
	CONSTRAINT "tally_companies_name_check" CHECK (btrim(tally_company_name) <> '')
);
--> statement-breakpoint
ALTER TABLE "accounts"."tally_companies" ADD CONSTRAINT "tally_companies_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_companies" ADD CONSTRAINT "tally_companies_drafted_by_persons_id_fk" FOREIGN KEY ("drafted_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_companies" ADD CONSTRAINT "tally_companies_approved_by_persons_id_fk" FOREIGN KEY ("approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER "trg_tally_companies_no_delete" BEFORE DELETE ON "accounts"."tally_companies"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_delete"();--> statement-breakpoint

-- 3. Carry the company names already typed on ledger mappings into tally_companies. One name per company is required: if a
-- company has two different names the migration stops and lists them, so nobody's name is silently dropped. Carried rows
-- are drafts (the start date is a guess: the first journal entry, else the first mapping) until the checker approves them.
DO $$
DECLARE clash text;
BEGIN
  SELECT string_agg(format('%s: %s', le.code, x.names), '; ') INTO clash FROM (
    SELECT m.legal_entity_id, string_agg(DISTINCT m.tally_company, ' | ') AS names
      FROM "accounts"."tally_ledger_map" m GROUP BY m.legal_entity_id HAVING count(DISTINCT m.tally_company) > 1) x
    JOIN "core"."legal_entities" le ON le.id = x.legal_entity_id;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTS_MIGRATION: these companies have more than one Tally company name on their ledger mappings (%). Make them the same, then run the migration again.', clash;
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "accounts"."tally_companies" ("tenant_id", "public_id", "legal_entity_id", "tally_company_name", "books_from", "state", "drafted_by", "drafted_at")
SELECT DISTINCT ON (m.legal_entity_id) m.tenant_id, gen_random_uuid(), m.legal_entity_id, m.tally_company,
       coalesce((SELECT min(e.entry_date) FROM "accounts"."journal_entries" e WHERE e.legal_entity_id = m.legal_entity_id),
                (m.drafted_at AT TIME ZONE 'Asia/Kolkata')::date),
       'draft', m.drafted_by, m.drafted_at
  FROM "accounts"."tally_ledger_map" m ORDER BY m.legal_entity_id, m.id;--> statement-breakpoint
ALTER TABLE "accounts"."tally_ledger_map" ADD CONSTRAINT "tally_ledger_map_tally_company_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "accounts"."tally_companies"("legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_ledger_map" DROP COLUMN "tally_company";--> statement-breakpoint

-- 4. Expense categories get a ledger key. The five standard codes map to expense.<code>. Any other category cannot be
-- mapped by a program: it is put on expense.other (so nothing is lost or blocked) and listed here for the accounts team.
ALTER TABLE "hrms"."expense_categories" ADD COLUMN "ledger_key" text;--> statement-breakpoint
UPDATE "hrms"."expense_categories" SET "ledger_key" = 'expense.' || "code" WHERE "code" IN ('fuel', 'travel', 'food', 'materials', 'other');--> statement-breakpoint
DO $$
DECLARE unmapped text;
BEGIN
  SELECT string_agg(format('tenant %s: %s (%s)', tenant_id, code, name), '; ') INTO unmapped FROM "hrms"."expense_categories" WHERE "ledger_key" IS NULL;
  IF unmapped IS NOT NULL THEN
    RAISE WARNING 'ACCOUNTS_MIGRATION: no ledger key could be chosen for these expense categories; they were set to expense.other, please review: %', unmapped;
  END IF;
END $$;--> statement-breakpoint
UPDATE "hrms"."expense_categories" SET "ledger_key" = 'expense.other' WHERE "ledger_key" IS NULL;--> statement-breakpoint
ALTER TABLE "hrms"."expense_categories" ALTER COLUMN "ledger_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."expense_categories" ADD CONSTRAINT "expense_categories_ledger_key_check" CHECK (ledger_key LIKE 'expense.%' AND accounts.is_ledger_key(ledger_key));--> statement-breakpoint

-- 5. Unknown keys are refused from now on. NOT VALID: new rows are checked, rows already stored are not rewritten (the
-- journal and posting rules are append-only). Old keys still stored are listed in a warning for the accounts team.
ALTER TABLE "accounts"."journal_lines" ADD CONSTRAINT "journal_lines_key_check" CHECK (accounts.is_ledger_key(ledger_key)) NOT VALID;--> statement-breakpoint
ALTER TABLE "accounts"."posting_rules" ADD CONSTRAINT "posting_rules_debit_key_check" CHECK (accounts.is_ledger_key(debit_ledger_key)) NOT VALID;--> statement-breakpoint
ALTER TABLE "accounts"."posting_rules" ADD CONSTRAINT "posting_rules_credit_key_check" CHECK (accounts.is_ledger_key(credit_ledger_key)) NOT VALID;--> statement-breakpoint
ALTER TABLE "accounts"."posting_rules" ADD CONSTRAINT "posting_rules_deduction_key_check" CHECK (deduction_ledger_key IS NULL OR accounts.is_ledger_key(deduction_ledger_key)) NOT VALID;--> statement-breakpoint
ALTER TABLE "accounts"."tally_ledger_map" ADD CONSTRAINT "tally_ledger_map_key_check" CHECK (accounts.is_ledger_key(ledger_key)) NOT VALID;--> statement-breakpoint
DO $$
DECLARE old_keys text;
BEGIN
  SELECT string_agg(DISTINCT x.k, ', ') INTO old_keys FROM (
    SELECT ledger_key AS k FROM "accounts"."journal_lines" UNION ALL SELECT ledger_key FROM "accounts"."tally_ledger_map"
    UNION ALL SELECT debit_ledger_key FROM "accounts"."posting_rules" UNION ALL SELECT credit_ledger_key FROM "accounts"."posting_rules"
    UNION ALL SELECT deduction_ledger_key FROM "accounts"."posting_rules") x
   WHERE x.k IS NOT NULL AND NOT accounts.is_ledger_key(x.k);
  IF old_keys IS NOT NULL THEN
    RAISE WARNING 'ACCOUNTS_MIGRATION: old ledger keys are still stored and were left as they are (not on the fixed list): %', old_keys;
  END IF;
END $$;
