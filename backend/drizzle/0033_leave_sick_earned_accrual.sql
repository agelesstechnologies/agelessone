ALTER TABLE "hrms"."leave_ledger" DROP CONSTRAINT "leave_ledger_entry_check";--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" DROP CONSTRAINT "leave_ledger_reason_required";--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ALTER COLUMN "posted_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD COLUMN "period" date;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "unpaid_days" numeric(5, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_types" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_leave_ledger_period" ON "hrms"."leave_ledger" USING btree ("employment_id","leave_type_id","entry","period") WHERE period IS NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD CONSTRAINT "leave_ledger_lapse_sign" CHECK (entry <> 'lapse' OR days < 0);--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD CONSTRAINT "leave_ledger_system_entries" CHECK (posted_by IS NOT NULL OR entry IN ('grant','lapse'));--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD CONSTRAINT "leave_ledger_entry_check" CHECK (entry IN ('opening','grant','taken','taken_reversal','adjustment','lapse'));--> statement-breakpoint
ALTER TABLE "hrms"."leave_ledger" ADD CONSTRAINT "leave_ledger_reason_required" CHECK (entry NOT IN ('opening','adjustment','grant','lapse') OR reason IS NOT NULL);--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_unpaid_days_check" CHECK (unpaid_days >= 0 AND unpaid_days <= days);--> statement-breakpoint
-- Leave types: Sick leave and Earned leave (paid, 1 a month each by the daily job), Leave without pay (unpaid).
-- General leave stays for history but can no longer be applied for.
INSERT INTO "hrms"."leave_types" ("tenant_id", "code", "name", "policy_key", "is_paid")
SELECT t."id", v.code, v.name, v.policy_key, v.is_paid FROM "core"."tenants" t,
  (VALUES ('SL', 'Sick leave', 'hrms.leave.sl', true), ('EL', 'Earned leave', 'hrms.leave.el', true), ('LWP', 'Leave without pay', 'hrms.leave.lwp', false))
  AS v(code, name, policy_key, is_paid)
ON CONFLICT ("tenant_id", "code") DO NOTHING;--> statement-breakpoint
UPDATE "hrms"."leave_types" SET "is_active" = false WHERE "code" = 'GL';
