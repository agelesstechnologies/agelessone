CREATE TABLE "hrms"."departments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."departments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"name" text NOT NULL,
	"code_prefix" text NOT NULL,
	"head_person_id" bigint,
	CONSTRAINT "departments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "departments_company_prefix_unique" UNIQUE("legal_entity_id","code_prefix"),
	CONSTRAINT "departments_company_name_unique" UNIQUE("legal_entity_id","name"),
	CONSTRAINT "departments_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "departments_prefix_format" CHECK (code_prefix ~ '^[A-Z]{2,6}$')
);
--> statement-breakpoint
CREATE TABLE "hrms"."designations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."designations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "designations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "designations_company_name_unique" UNIQUE("legal_entity_id","name"),
	CONSTRAINT "designations_id_company_unique" UNIQUE("id","legal_entity_id")
);
--> statement-breakpoint
CREATE TABLE "hrms"."positions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."positions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"department_id" bigint NOT NULL,
	"designation_id" bigint NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"notes" text,
	"filled_by_employment_id" bigint,
	"filled_at" timestamp with time zone,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "positions_status_check" CHECK (status IN ('planned','open','filled')),
	CONSTRAINT "positions_filled_has_employment" CHECK ((status = 'filled') = (filled_by_employment_id IS NOT NULL))
);
--> statement-breakpoint
DROP INDEX "hrms"."uq_active_employment_per_company";--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD COLUMN "recruited_on" date;--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD COLUMN "department_id" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD COLUMN "offer_letter_path" text;--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD COLUMN "offer_letter_type" text;--> statement-breakpoint
ALTER TABLE "hrms"."departments" ADD CONSTRAINT "departments_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."departments" ADD CONSTRAINT "departments_head_person_id_persons_id_fk" FOREIGN KEY ("head_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."designations" ADD CONSTRAINT "designations_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."positions" ADD CONSTRAINT "positions_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."positions" ADD CONSTRAINT "positions_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."positions" ADD CONSTRAINT "positions_department_company_fk" FOREIGN KEY ("department_id","legal_entity_id") REFERENCES "hrms"."departments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."positions" ADD CONSTRAINT "positions_designation_company_fk" FOREIGN KEY ("designation_id","legal_entity_id") REFERENCES "hrms"."designations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."positions" ADD CONSTRAINT "positions_employment_company_fk" FOREIGN KEY ("filled_by_employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_positions_company_status" ON "hrms"."positions" USING btree ("legal_entity_id","status");--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD CONSTRAINT "employments_department_company_fk" FOREIGN KEY ("department_id","legal_entity_id") REFERENCES "hrms"."departments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_active_employment_per_company" ON "hrms"."employments" USING btree ("person_id","legal_entity_id") WHERE status IN ('joining','active','notice');--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD CONSTRAINT "employments_status_check" CHECK (status IN ('joining','active','notice','exited'));--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD CONSTRAINT "employments_recruited_before_join" CHECK (recruited_on IS NULL OR recruited_on <= joined_on);--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.positions.manage', 'hrms', 'Plan, open and fill positions');
