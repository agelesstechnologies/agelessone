CREATE TABLE "core"."person_contacts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."person_contacts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"person_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"label" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "person_contacts_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "person_contacts_kind_check" CHECK (kind IN ('phone','email','other'))
);
--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD COLUMN "legal_entity_id" bigint;--> statement-breakpoint
-- Existing development rows: company taken from the employee code prefix (AE-..., ATPL-...); each was the person's only job.
UPDATE "hrms"."employments" e SET "legal_entity_id" = le."id" FROM "core"."legal_entities" le
  WHERE le."tenant_id" = e."tenant_id" AND e."employee_code" LIKE le."code" || '-%';--> statement-breakpoint
ALTER TABLE "hrms"."employments" ALTER COLUMN "legal_entity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "hrms"."employments" SET "is_primary" = true;--> statement-breakpoint
ALTER TABLE "core"."person_contacts" ADD CONSTRAINT "person_contacts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_person_contacts_person" ON "core"."person_contacts" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_one_primary_contact" ON "core"."person_contacts" USING btree ("person_id","kind") WHERE is_primary AND ended_at IS NULL;--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD CONSTRAINT "employments_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_active_employment_per_company" ON "hrms"."employments" USING btree ("person_id","legal_entity_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_one_primary_employment" ON "hrms"."employments" USING btree ("person_id") WHERE is_primary AND status = 'active';--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD CONSTRAINT "employments_company_code_unique" UNIQUE("legal_entity_id","employee_code");