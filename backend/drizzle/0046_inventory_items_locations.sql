CREATE SCHEMA "inventory";
--> statement-breakpoint
CREATE TABLE "inventory"."item_categories" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."item_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"name" text NOT NULL,
	"code_prefix" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_categories_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "item_categories_company_prefix_unique" UNIQUE("legal_entity_id","code_prefix"),
	CONSTRAINT "item_categories_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "item_categories_prefix_format" CHECK (code_prefix ~ '^[A-Z][A-Z0-9]{1,5}$'),
	CONSTRAINT "item_categories_name_length" CHECK (char_length(name) BETWEEN 2 AND 60),
	CONSTRAINT "item_categories_status_check" CHECK (status IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "inventory"."item_uom_conversions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."item_uom_conversions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"unit_id" bigint NOT NULL,
	"factor" numeric(18, 6) NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_by" bigint,
	"ended_at" timestamp with time zone,
	CONSTRAINT "item_uom_conversions_factor_check" CHECK (factor > 0),
	CONSTRAINT "item_uom_conversions_ended_fields" CHECK ((ended_by IS NULL) = (ended_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "inventory"."items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" bigint NOT NULL,
	"base_unit_id" bigint NOT NULL,
	"tracking" text DEFAULT 'none' NOT NULL,
	"hsn_code" text,
	"is_stocked" boolean DEFAULT true NOT NULL,
	"reorder_level" numeric(18, 4),
	"reorder_qty" numeric(18, 4),
	"default_location_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone,
	CONSTRAINT "items_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "items_company_code_unique" UNIQUE("legal_entity_id","code"),
	CONSTRAINT "items_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "items_code_format" CHECK (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,29}$'),
	CONSTRAINT "items_name_length" CHECK (char_length(name) BETWEEN 2 AND 120),
	CONSTRAINT "items_description_length" CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 1000),
	CONSTRAINT "items_tracking_check" CHECK (tracking IN ('none','batch','serial')),
	CONSTRAINT "items_hsn_format" CHECK (hsn_code IS NULL OR hsn_code ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
	CONSTRAINT "items_not_stocked_fields" CHECK (is_stocked OR (tracking = 'none' AND reorder_level IS NULL AND reorder_qty IS NULL AND default_location_id IS NULL)),
	CONSTRAINT "items_reorder_check" CHECK ((reorder_level IS NULL OR reorder_level >= 0) AND (reorder_qty IS NULL OR reorder_qty > 0)),
	CONSTRAINT "items_status_check" CHECK (status IN ('active','inactive')),
	CONSTRAINT "items_updated_fields" CHECK ((updated_by IS NULL) = (updated_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "inventory"."locations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."locations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"type" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" bigint,
	"custodian_employment_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone,
	CONSTRAINT "locations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "locations_company_code_unique" UNIQUE("legal_entity_id","code"),
	CONSTRAINT "locations_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "locations_type_check" CHECK (type IN ('store','rack','bin','work_area','testing','transit','quarantine','scrap')),
	CONSTRAINT "locations_code_format" CHECK (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,29}$'),
	CONSTRAINT "locations_name_length" CHECK (char_length(name) BETWEEN 2 AND 80),
	CONSTRAINT "locations_parent_by_type" CHECK ((type IN ('rack','bin')) = (parent_id IS NOT NULL)),
	CONSTRAINT "locations_custodian_needed" CHECK (type IN ('rack','bin') OR custodian_employment_id IS NOT NULL),
	CONSTRAINT "locations_not_own_parent" CHECK (parent_id IS NULL OR parent_id <> id),
	CONSTRAINT "locations_status_check" CHECK (status IN ('active','inactive')),
	CONSTRAINT "locations_updated_fields" CHECK ((updated_by IS NULL) = (updated_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "inventory"."units" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."units_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"decimals" smallint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "units_company_code_unique" UNIQUE("legal_entity_id","code"),
	CONSTRAINT "units_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "units_code_format" CHECK (code ~ '^[a-z][a-z0-9_.]{0,11}$'),
	CONSTRAINT "units_name_length" CHECK (char_length(name) BETWEEN 1 AND 40),
	CONSTRAINT "units_decimals_check" CHECK (decimals BETWEEN 0 AND 4),
	CONSTRAINT "units_status_check" CHECK (status IN ('active','inactive'))
);
--> statement-breakpoint
ALTER TABLE "inventory"."item_categories" ADD CONSTRAINT "item_categories_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."item_categories" ADD CONSTRAINT "item_categories_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."item_uom_conversions" ADD CONSTRAINT "item_uom_conversions_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."item_uom_conversions" ADD CONSTRAINT "item_uom_conversions_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."item_uom_conversions" ADD CONSTRAINT "item_uom_conversions_ended_by_persons_id_fk" FOREIGN KEY ("ended_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."item_uom_conversions" ADD CONSTRAINT "item_uom_conversions_item_company_fk" FOREIGN KEY ("item_id","legal_entity_id") REFERENCES "inventory"."items"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."item_uom_conversions" ADD CONSTRAINT "item_uom_conversions_unit_company_fk" FOREIGN KEY ("unit_id","legal_entity_id") REFERENCES "inventory"."units"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."items" ADD CONSTRAINT "items_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."items" ADD CONSTRAINT "items_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."items" ADD CONSTRAINT "items_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."items" ADD CONSTRAINT "items_category_company_fk" FOREIGN KEY ("category_id","legal_entity_id") REFERENCES "inventory"."item_categories"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."items" ADD CONSTRAINT "items_base_unit_company_fk" FOREIGN KEY ("base_unit_id","legal_entity_id") REFERENCES "inventory"."units"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."items" ADD CONSTRAINT "items_default_location_company_fk" FOREIGN KEY ("default_location_id","legal_entity_id") REFERENCES "inventory"."locations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."locations" ADD CONSTRAINT "locations_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."locations" ADD CONSTRAINT "locations_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."locations" ADD CONSTRAINT "locations_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."locations" ADD CONSTRAINT "locations_parent_company_fk" FOREIGN KEY ("parent_id","legal_entity_id") REFERENCES "inventory"."locations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."locations" ADD CONSTRAINT "locations_custodian_company_fk" FOREIGN KEY ("custodian_employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."units" ADD CONSTRAINT "units_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."units" ADD CONSTRAINT "units_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_categories_company_name_unique" ON "inventory"."item_categories" USING btree ("legal_entity_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "item_uom_conversions_one_current" ON "inventory"."item_uom_conversions" USING btree ("item_id","unit_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "items_company_name_unique" ON "inventory"."items" USING btree ("legal_entity_id",lower("name"));--> statement-breakpoint
CREATE INDEX "idx_items_company_category" ON "inventory"."items" USING btree ("legal_entity_id","category_id");--> statement-breakpoint
CREATE INDEX "idx_locations_parent" ON "inventory"."locations" USING btree ("parent_id");--> statement-breakpoint
-- Inventory records are never deleted: they become inactive (conversions are ended), and changes stay in core.audit_log.
CREATE FUNCTION "inventory"."refuse_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory.% rows are never deleted: make them inactive instead', TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_units_never_deleted" BEFORE DELETE ON "inventory"."units" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_item_categories_never_deleted" BEFORE DELETE ON "inventory"."item_categories" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_locations_never_deleted" BEFORE DELETE ON "inventory"."locations" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_items_never_deleted" BEFORE DELETE ON "inventory"."items" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_item_uom_conversions_never_deleted" BEFORE DELETE ON "inventory"."item_uom_conversions" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
-- Permissions. Scope all: every company of the tenant. Scope team: the companies the person has a current job in.
-- Scope own: those companies' catalog, but stock, documents and locations only where the person is responsible (the
-- location's custodian, or its parent's for racks and bins). Inventory is need-to-know: staff hold none of these.
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('inventory.view', 'inventory', 'See units, item categories, items, store locations, stock and values (team: companies you work in; own: only the locations you are responsible for; all: every company)'),
  ('inventory.items.manage', 'inventory', 'Add and change units, item categories and items, copy items from another company, import items from CSV (companies you work in; scope all: every company)'),
  ('inventory.locations.manage', 'inventory', 'Add, change and import store locations (team: every location of companies you work in; own: change only the locations you are responsible for; all: every company)'),
  ('inventory.stock.post', 'inventory', 'Post receipts, issues, returns and transfers (team: any location of companies you work in; own: only locations you are responsible for; all: every company)'),
  ('inventory.request', 'inventory', 'Parts requester: request parts on tickets you are assigned to whose ticket type uses parts (policy inventory.parts.ticket_types). No store browsing, no values'),
  ('inventory.department.view', 'inventory', 'Department head: parts requested and used on tickets of the departments you head, with cost, and approval above the limit (all: every department)')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- Roles for existing tenants (new databases get them from the seed). The Accounts roles use the codes of the Accounts
-- module (created here if they do not exist yet) and only read inventory.
INSERT INTO "core"."roles" ("tenant_id", "code", "name")
SELECT t."id", v."code", v."name" FROM "core"."tenants" t
 CROSS JOIN (VALUES ('storekeeper', 'Storekeeper'), ('store_incharge', 'Store in-charge'), ('inventory_controller', 'Inventory controller'),
                    ('parts_requester', 'Parts requester'), ('accounts_executive', 'Accounts executive'), ('accounts_manager', 'Accounts manager')) AS v("code", "name")
ON CONFLICT ("tenant_id", "code") DO NOTHING;--> statement-breakpoint
-- Store roles: the same permissions until the stock steps give each its own approvals; the scope given with the role
-- decides the reach (Storekeeper normally own: the locations they look after; Store in-charge and Inventory controller team).
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r
  JOIN "core"."permissions" p ON p."code" IN ('inventory.view', 'inventory.items.manage', 'inventory.locations.manage', 'inventory.stock.post')
 WHERE r."code" IN ('storekeeper', 'store_incharge', 'inventory_controller')
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Accounts and the CEO (Management, CEO) read; Parts requesters request; department heads (Manager role) see their
-- departments' parts and cost.
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" = 'inventory.view'
 WHERE r."code" IN ('accounts_executive', 'accounts_manager', 'management', 'ceo')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" = 'inventory.request'
 WHERE r."code" = 'parts_requester'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" = 'inventory.department.view'
 WHERE r."code" = 'manager'
ON CONFLICT DO NOTHING;
