CREATE TABLE "hrms"."person_skills" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."person_skills_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"person_id" bigint NOT NULL,
	"skill_id" bigint NOT NULL,
	"level" text NOT NULL,
	"verified_by" bigint,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_skills_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "person_skills_person_skill_unique" UNIQUE("person_id","skill_id"),
	CONSTRAINT "person_skills_level_check" CHECK (level IN ('trainee','skilled','expert')),
	CONSTRAINT "person_skills_not_self_verified" CHECK (verified_by IS NULL OR verified_by <> person_id),
	CONSTRAINT "person_skills_verified_together" CHECK ((verified_by IS NULL) = (verified_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD COLUMN "issuer" text;--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD COLUMN "number" text;--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD COLUMN "issued_on" date;--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD COLUMN "file_path" text;--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD COLUMN "file_type" text;--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD COLUMN "verified_by" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."skills" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."skills" ADD COLUMN "legal_entity_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."skills" ADD COLUMN "department_id" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."person_skills" ADD CONSTRAINT "person_skills_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."person_skills" ADD CONSTRAINT "person_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "hrms"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."person_skills" ADD CONSTRAINT "person_skills_verified_by_persons_id_fk" FOREIGN KEY ("verified_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD CONSTRAINT "certificates_verified_by_persons_id_fk" FOREIGN KEY ("verified_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."skills" ADD CONSTRAINT "skills_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."skills" ADD CONSTRAINT "skills_department_company_fk" FOREIGN KEY ("department_id","legal_entity_id") REFERENCES "hrms"."departments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_certificates_expires" ON "hrms"."certificates" USING btree ("tenant_id","expires_on");--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD CONSTRAINT "certificates_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "hrms"."skills" ADD CONSTRAINT "skills_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "hrms"."skills" ADD CONSTRAINT "skills_company_code_unique" UNIQUE("legal_entity_id","code");--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD CONSTRAINT "certificates_status_check" CHECK (status IN ('review','verified','expired'));--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD CONSTRAINT "certificates_dates_check" CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on);--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD CONSTRAINT "certificates_not_self_verified" CHECK (verified_by IS NULL OR verified_by <> person_id);--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.skills.manage', 'hrms', 'Keep the skills list; see expiring certificates and any certificate file'),
  ('hrms.skills.add',    'hrms', 'Add skills and certificates (own: yours; team: people you manage)'),
  ('hrms.skills.verify', 'hrms', 'Verify skills and certificates (team: people you manage); never your own'),
  ('hrms.skills.view',   'hrms', 'Skills matrix (own: yourself; team: people you manage)');
