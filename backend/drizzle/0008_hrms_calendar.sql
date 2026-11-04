CREATE TABLE "hrms"."holiday_calendars" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."holiday_calendars_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"year" integer NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "holiday_calendars_company_year_unique" UNIQUE("legal_entity_id","year")
);
--> statement-breakpoint
CREATE TABLE "hrms"."holidays" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."holidays_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"calendar_id" bigint NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holidays_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "holidays_calendar_date_unique" UNIQUE("calendar_id","date")
);
--> statement-breakpoint
CREATE TABLE "hrms"."weekly_off_rules" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."weekly_off_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint,
	"employment_id" bigint,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"rule" jsonb NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_off_rules_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "weekly_off_rules_one_target" CHECK ((legal_entity_id IS NULL) <> (employment_id IS NULL)),
	CONSTRAINT "weekly_off_rules_dates" CHECK (valid_to IS NULL OR valid_to >= valid_from),
	CONSTRAINT "weekly_off_rules_rule_object" CHECK (jsonb_typeof(rule) = 'object')
);
--> statement-breakpoint
ALTER TABLE "hrms"."holiday_calendars" ADD CONSTRAINT "holiday_calendars_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."holidays" ADD CONSTRAINT "holidays_calendar_id_holiday_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "hrms"."holiday_calendars"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."holidays" ADD CONSTRAINT "holidays_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."weekly_off_rules" ADD CONSTRAINT "weekly_off_rules_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."weekly_off_rules" ADD CONSTRAINT "weekly_off_rules_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "hrms"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."weekly_off_rules" ADD CONSTRAINT "weekly_off_rules_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_weekly_off_rules_employment" ON "hrms"."weekly_off_rules" USING btree ("employment_id");--> statement-breakpoint
-- No two weekly-off rules of the same company, or of the same job, cover the same date (btree_gist lets "=" join "&&").
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "hrms"."weekly_off_rules" ADD CONSTRAINT "weekly_off_rules_company_no_overlap"
  EXCLUDE USING gist (legal_entity_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&) WHERE (legal_entity_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "hrms"."weekly_off_rules" ADD CONSTRAINT "weekly_off_rules_employment_no_overlap"
  EXCLUDE USING gist (employment_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&) WHERE (employment_id IS NOT NULL);--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.calendar.manage', 'hrms', 'Add and remove holidays; set weekly offs for a company or a person');
