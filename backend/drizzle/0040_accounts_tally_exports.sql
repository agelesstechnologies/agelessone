CREATE TABLE "accounts"."tally_batches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."tally_batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"tally_company_name" text NOT NULL,
	"state" text DEFAULT 'built' NOT NULL,
	"entry_count" integer NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"request_xml" text NOT NULL,
	"response_xml" text,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tally_batches_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tally_batches_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "tally_batches_state_check" CHECK (state IN ('built','sent','accepted','rejected')),
	CONSTRAINT "tally_batches_counts_check" CHECK (entry_count > 0 AND total_minor > 0),
	CONSTRAINT "tally_batches_currency_check" CHECK (currency = 'INR')
);
--> statement-breakpoint
CREATE TABLE "accounts"."tally_exports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."tally_exports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" bigint NOT NULL,
	"entry_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"remote_id" uuid NOT NULL,
	"voucher_type" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"tally_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tally_exports_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tally_exports_batch_entry_unique" UNIQUE("batch_id","entry_id"),
	CONSTRAINT "tally_exports_state_check" CHECK (state IN ('pending','created','failed')),
	CONSTRAINT "tally_exports_voucher_type_check" CHECK (voucher_type IN ('Platform Journal','Platform Payment'))
);
--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_tally_company_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "accounts"."tally_companies"("legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_exports" ADD CONSTRAINT "tally_exports_batch_company_fk" FOREIGN KEY ("batch_id","legal_entity_id") REFERENCES "accounts"."tally_batches"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_exports" ADD CONSTRAINT "tally_exports_entry_company_fk" FOREIGN KEY ("entry_id","legal_entity_id") REFERENCES "accounts"."journal_entries"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tally_batches_company" ON "accounts"."tally_batches" USING btree ("legal_entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tally_exports_entry_once" ON "accounts"."tally_exports" USING btree ("entry_id") WHERE state <> 'failed';
--> statement-breakpoint
-- What was sent to Tally is kept for history: never deleted. The journal itself is not touched by these tables.
CREATE TRIGGER "trg_tally_batches_no_delete" BEFORE DELETE ON "accounts"."tally_batches"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_tally_exports_no_delete" BEFORE DELETE ON "accounts"."tally_exports"
  FOR EACH ROW EXECUTE FUNCTION "accounts"."forbid_delete"();
