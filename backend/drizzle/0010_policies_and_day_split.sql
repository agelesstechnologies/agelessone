CREATE TABLE "core"."policies" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."policies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint,
	"policy_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"approved_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "policies_version_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","legal_entity_id","policy_key","version"),
	CONSTRAINT "policies_version_positive" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD COLUMN "leave_days" numeric(2, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD COLUMN "absent_days" numeric(2, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD COLUMN "worked_on_leave" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."policies" ADD CONSTRAINT "policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."policies" ADD CONSTRAINT "policies_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."policies" ADD CONSTRAINT "policies_approved_by_persons_id_fk" FOREIGN KEY ("approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_policies_key" ON "core"."policies" USING btree ("tenant_id","policy_key","effective_from");--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD CONSTRAINT "work_days_leave_absent_check" CHECK (leave_days IN (0, 0.5, 1) AND absent_days IN (0, 0.5, 1) AND leave_days + absent_days <= 1);--> statement-breakpoint
-- Policies are append-only: a change is a new version.
CREATE FUNCTION "core"."forbid_policy_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CORE_POLICY_APPEND_ONLY: policies cannot be changed or deleted (% refused); add a new version', TG_OP USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_policies_append_only" BEFORE UPDATE OR DELETE ON "core"."policies"
  FOR EACH ROW EXECUTE FUNCTION "core"."forbid_policy_change"();--> statement-breakpoint
-- Work days stored before this migration: fill leave and absent days from the status (locked days stay as they are).
-- Half-day leave is only split correctly by a rebuild (POST /api/hrms/attendance/rebuild).
UPDATE "hrms"."work_days" SET
  "leave_days" = CASE WHEN day_status = 'leave' THEN 1 ELSE 0 END,
  "absent_days" = CASE day_status WHEN 'absent' THEN 1 WHEN 'half_day' THEN 0.5 ELSE 0 END
WHERE NOT locked_for_payroll;--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('core.policies.manage', 'core', 'See company policies and add new versions');
