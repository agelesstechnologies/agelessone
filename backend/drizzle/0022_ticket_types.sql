CREATE TABLE "tickets"."ticket_types" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_types_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"owner_department_id" bigint,
	"is_standard" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completion_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checklist_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_types_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "ticket_types_public_version_unique" UNIQUE("public_id","version"),
	CONSTRAINT "ticket_types_version_check" CHECK (version >= 1),
	CONSTRAINT "ticket_types_code_format" CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "ticket_types_json_shapes" CHECK (jsonb_typeof(fields) = 'array' AND jsonb_typeof(completion_rules) = 'object' AND jsonb_typeof(checklist_items) = 'array')
);
--> statement-breakpoint
ALTER TABLE "tickets"."ticket_types" ADD CONSTRAINT "ticket_types_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_types" ADD CONSTRAINT "ticket_types_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_types" ADD CONSTRAINT "ticket_types_department_company_fk" FOREIGN KEY ("owner_department_id","legal_entity_id") REFERENCES "hrms"."departments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_types_one_current" ON "tickets"."ticket_types" USING btree ("public_id") WHERE is_current;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_types_company_name_unique" ON "tickets"."ticket_types" USING btree ("legal_entity_id",lower("name")) WHERE is_current;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_types_company_code_unique" ON "tickets"."ticket_types" USING btree ("legal_entity_id","code") WHERE is_current;--> statement-breakpoint
-- Old versions are kept and types are never deleted: only active and is_current may change on a row.
CREATE FUNCTION "tickets"."guard_ticket_type"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'active' - 'is_current') <> (to_jsonb(OLD) - 'active' - 'is_current') THEN
    RAISE EXCEPTION 'TICKETS_TYPE_VERSIONS_KEPT: ticket types are never deleted and a saved version is never edited; save a new version (% refused)', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ticket_types_versions_kept" BEFORE UPDATE OR DELETE ON "tickets"."ticket_types"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."guard_ticket_type"();--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('tickets.types.view',   'tickets', 'See ticket types (read only)'),
  ('tickets.types.manage', 'tickets', 'Ticket types: scope all (admin user, Management) manages every type, standard ones too; otherwise a department head manages the non-standard types their department owns');
