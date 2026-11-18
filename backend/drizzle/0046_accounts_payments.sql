CREATE TABLE "accounts"."bank_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."bank_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"bank_ledger_key" text NOT NULL,
	"txn_date" date NOT NULL,
	"description" text NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"debit_minor" bigint DEFAULT 0 NOT NULL,
	"credit_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"state" text DEFAULT 'unmatched' NOT NULL,
	"matched_batch_id" bigint,
	"matched_by" bigint,
	"matched_at" timestamp with time zone,
	"imported_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_lines_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "bank_lines_row_unique" UNIQUE("legal_entity_id","bank_ledger_key","txn_date","reference","debit_minor","credit_minor","description"),
	CONSTRAINT "bank_lines_amount_check" CHECK (debit_minor >= 0 AND credit_minor >= 0 AND (debit_minor > 0) <> (credit_minor > 0)),
	CONSTRAINT "bank_lines_bank_check" CHECK (bank_ledger_key IN ('bank.operating','bank.salary')),
	CONSTRAINT "bank_lines_state_check" CHECK (state IN ('unmatched','matched')),
	CONSTRAINT "bank_lines_matched_check" CHECK ((state = 'matched') = (matched_batch_id IS NOT NULL AND matched_by IS NOT NULL AND matched_at IS NOT NULL)),
	CONSTRAINT "bank_lines_match_out_check" CHECK (matched_batch_id IS NULL OR debit_minor > 0),
	CONSTRAINT "bank_lines_currency_check" CHECK (currency = 'INR')
);
--> statement-breakpoint
CREATE TABLE "accounts"."payment_batches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."payment_batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"bank_ledger_key" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"request_count" integer NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" bigint,
	"approved_at" timestamp with time zone,
	"paid_by" bigint,
	"paid_at" timestamp with time zone,
	"paid_on" date,
	"bank_reference" text,
	CONSTRAINT "payment_batches_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_batches_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "payment_batches_state_check" CHECK (state IN ('draft','approved','paid','cancelled')),
	CONSTRAINT "payment_batches_bank_check" CHECK (bank_ledger_key IN ('bank.operating','bank.salary')),
	CONSTRAINT "payment_batches_counts_check" CHECK (request_count > 0 AND total_minor > 0),
	CONSTRAINT "payment_batches_currency_check" CHECK (currency = 'INR'),
	CONSTRAINT "payment_batches_approval_check" CHECK ((approved_by IS NULL) = (approved_at IS NULL) AND (state NOT IN ('approved','paid') OR approved_by IS NOT NULL)),
	CONSTRAINT "payment_batches_not_own_approval" CHECK (approved_by IS NULL OR approved_by <> created_by),
	CONSTRAINT "payment_batches_paid_check" CHECK ((state = 'paid') = (paid_by IS NOT NULL AND paid_at IS NOT NULL AND paid_on IS NOT NULL AND bank_reference IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "accounts"."payment_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."payment_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"payee_name" text NOT NULL,
	"payee_kind" text NOT NULL,
	"purpose" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"due_date" date NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"requested_by" bigint NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" bigint,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"batch_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_requests_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_requests_state_check" CHECK (state IN ('pending','approved','rejected','batched','paid','cancelled')),
	CONSTRAINT "payment_requests_kind_check" CHECK (payee_kind IN ('vendor','employee','other')),
	CONSTRAINT "payment_requests_amount_check" CHECK (amount_minor > 0),
	CONSTRAINT "payment_requests_currency_check" CHECK (currency = 'INR'),
	CONSTRAINT "payment_requests_decided_check" CHECK ((state IN ('pending','cancelled')) OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
	CONSTRAINT "payment_requests_not_own_approval" CHECK (decided_by IS NULL OR decided_by <> requested_by),
	CONSTRAINT "payment_requests_batch_check" CHECK ((state IN ('batched','paid')) = (batch_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "accounts"."bank_lines" ADD CONSTRAINT "bank_lines_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."bank_lines" ADD CONSTRAINT "bank_lines_matched_by_persons_id_fk" FOREIGN KEY ("matched_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."bank_lines" ADD CONSTRAINT "bank_lines_imported_by_persons_id_fk" FOREIGN KEY ("imported_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."bank_lines" ADD CONSTRAINT "bank_lines_batch_company_fk" FOREIGN KEY ("matched_batch_id","legal_entity_id") REFERENCES "accounts"."payment_batches"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."payment_batches" ADD CONSTRAINT "payment_batches_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."payment_batches" ADD CONSTRAINT "payment_batches_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."payment_batches" ADD CONSTRAINT "payment_batches_approved_by_persons_id_fk" FOREIGN KEY ("approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."payment_batches" ADD CONSTRAINT "payment_batches_paid_by_persons_id_fk" FOREIGN KEY ("paid_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."payment_requests" ADD CONSTRAINT "payment_requests_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."payment_requests" ADD CONSTRAINT "payment_requests_requested_by_persons_id_fk" FOREIGN KEY ("requested_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."payment_requests" ADD CONSTRAINT "payment_requests_decided_by_persons_id_fk" FOREIGN KEY ("decided_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."payment_requests" ADD CONSTRAINT "payment_requests_batch_company_fk" FOREIGN KEY ("batch_id","legal_entity_id") REFERENCES "accounts"."payment_batches"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_lines_batch_once" ON "accounts"."bank_lines" USING btree ("matched_batch_id") WHERE matched_batch_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_bank_lines_company" ON "accounts"."bank_lines" USING btree ("legal_entity_id","txn_date");--> statement-breakpoint
CREATE INDEX "idx_payment_batches_company" ON "accounts"."payment_batches" USING btree ("legal_entity_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_payment_requests_company" ON "accounts"."payment_requests" USING btree ("legal_entity_id","state","due_date");--> statement-breakpoint
-- Payment requests, batches and bank lines are kept for history: never deleted.
CREATE TRIGGER "trg_payment_requests_no_delete" BEFORE DELETE ON "accounts"."payment_requests"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_payment_batches_no_delete" BEFORE DELETE ON "accounts"."payment_batches"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_bank_lines_no_delete" BEFORE DELETE ON "accounts"."bank_lines"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_delete"();
