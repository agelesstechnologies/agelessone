CREATE TABLE "core"."machine_credentials" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."machine_credentials_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"client_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"permission" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "machine_credentials_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "machine_credentials_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "machine_credentials_permission_check" CHECK (permission IN ('accounts.tally.connector')),
	CONSTRAINT "machine_credentials_revoked_check" CHECK (is_active = (revoked_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" DROP CONSTRAINT "tally_batches_finished_check";--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD COLUMN "finished_by_machine" bigint;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD COLUMN "connector_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD COLUMN "connector_message" text;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD COLUMN "connector_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts"."tally_companies" ADD COLUMN "connector_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts"."tally_companies" ADD COLUMN "connector_missing" jsonb;--> statement-breakpoint
ALTER TABLE "core"."machine_credentials" ADD CONSTRAINT "machine_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."machine_credentials" ADD CONSTRAINT "machine_credentials_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_finished_by_machine_machine_credentials_id_fk" FOREIGN KEY ("finished_by_machine") REFERENCES "core"."machine_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_hold_check" CHECK (NOT connector_hold OR state = 'approved');--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_finished_check" CHECK ((state IN ('imported','cancelled')) = (finished_at IS NOT NULL AND (finished_by IS NOT NULL OR finished_by_machine IS NOT NULL)));
--> statement-breakpoint
-- A machine credential is revoked, never deleted: the record of who it was stays.
CREATE FUNCTION "core"."forbid_machine_credential_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CORE_NO_DELETE: machine credentials are revoked, never deleted' USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_machine_credentials_no_delete" BEFORE DELETE ON "core"."machine_credentials"
  FOR EACH ROW EXECUTE FUNCTION "core"."forbid_machine_credential_delete"();--> statement-breakpoint
-- The one permission a machine credential can hold (the permission list is added by migrations).
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('accounts.tally.connector', 'accounts', 'Tally connector (a machine credential, not a person): read the approved Tally batches, report import results and the ledger name check');
