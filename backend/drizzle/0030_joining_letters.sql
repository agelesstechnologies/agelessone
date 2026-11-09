CREATE TABLE "hrms"."issued_letters" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."issued_letters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"person_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"issued_by" bigint NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issued_letters_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "issued_letters_kind_check" CHECK (kind IN ('joining')),
	CONSTRAINT "issued_letters_text_check" CHECK (char_length(title) BETWEEN 1 AND 200 AND char_length(body) BETWEEN 1 AND 20000)
);
--> statement-breakpoint
CREATE TABLE "hrms"."letter_templates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."letter_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"updated_by" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "letter_templates_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "letter_templates_company_kind_unique" UNIQUE("legal_entity_id","kind"),
	CONSTRAINT "letter_templates_kind_check" CHECK (kind IN ('joining')),
	CONSTRAINT "letter_templates_text_check" CHECK (char_length(title) BETWEEN 1 AND 200 AND char_length(body) BETWEEN 1 AND 20000)
);
--> statement-breakpoint
ALTER TABLE "hrms"."issued_letters" ADD CONSTRAINT "issued_letters_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."issued_letters" ADD CONSTRAINT "issued_letters_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."issued_letters" ADD CONSTRAINT "issued_letters_issued_by_persons_id_fk" FOREIGN KEY ("issued_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."issued_letters" ADD CONSTRAINT "issued_letters_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."letter_templates" ADD CONSTRAINT "letter_templates_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."letter_templates" ADD CONSTRAINT "letter_templates_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_issued_letters_employment" ON "hrms"."issued_letters" USING btree ("employment_id","issued_at");--> statement-breakpoint
-- Issued letters are kept exactly as downloaded.
CREATE FUNCTION "hrms"."forbid_issued_letter_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HRMS_LETTER_APPEND_ONLY: issued letters cannot be changed or deleted (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_issued_letters_append_only" BEFORE UPDATE OR DELETE ON "hrms"."issued_letters"
  FOR EACH ROW EXECUTE FUNCTION "hrms"."forbid_issued_letter_change"();--> statement-breakpoint
-- Who edits letter templates and issues letters: HR and Management (the CEO).
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.letters.manage', 'hrms', 'Edit letter templates and issue letters (joining letter) for any job, with a kept copy: HR and Management')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- existing databases: HR and Management get it (new databases get it from the seed)
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" = 'hrms.letters.manage'
 WHERE r."code" IN ('hr', 'management')
ON CONFLICT DO NOTHING;
