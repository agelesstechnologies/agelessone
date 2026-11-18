CREATE TABLE "inventory"."cross_company_grants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."cross_company_grants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"person_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"valid_until" date NOT NULL,
	"granted_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_by" bigint,
	"ended_at" timestamp with time zone,
	CONSTRAINT "cross_company_grants_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "cross_company_grants_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "cross_company_grants_not_self" CHECK (granted_by <> person_id),
	CONSTRAINT "cross_company_grants_ended_fields" CHECK ((ended_by IS NULL) = (ended_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "inventory"."part_request_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."part_request_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"request_id" bigint NOT NULL,
	"line_no" integer NOT NULL,
	"item_id" bigint NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"location_id" bigint,
	"issued_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"estimated_value_minor" bigint NOT NULL,
	CONSTRAINT "part_request_lines_request_line_unique" UNIQUE("request_id","line_no"),
	CONSTRAINT "part_request_lines_request_item_unique" UNIQUE("request_id","item_id"),
	CONSTRAINT "part_request_lines_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "part_request_lines_quantity_check" CHECK (quantity > 0 AND issued_qty >= 0 AND issued_qty <= quantity AND line_no >= 1)
);
--> statement-breakpoint
CREATE TABLE "inventory"."part_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."part_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"number" text NOT NULL,
	"ticket_id" bigint NOT NULL,
	"project_id" bigint,
	"requested_by" bigint NOT NULL,
	"grant_id" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"estimated_value_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"needs_head_approval" boolean NOT NULL,
	"store_approved_by" bigint,
	"store_approved_at" timestamp with time zone,
	"head_approved_by" bigint,
	"head_approved_at" timestamp with time zone,
	"reserve_until" date,
	"decided_by" bigint,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "part_requests_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "part_requests_company_number_unique" UNIQUE("legal_entity_id","number"),
	CONSTRAINT "part_requests_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "part_requests_status_check" CHECK (status IN ('pending','approved','fulfilled','rejected','cancelled','expired','closed')),
	CONSTRAINT "part_requests_money_check" CHECK (estimated_value_minor >= 0 AND currency = 'INR'),
	CONSTRAINT "part_requests_not_own_decision" CHECK ((store_approved_by IS NULL OR store_approved_by <> requested_by) AND (head_approved_by IS NULL OR head_approved_by <> requested_by)
    AND (decided_by IS NULL OR status = 'cancelled' OR decided_by <> requested_by)),
	CONSTRAINT "part_requests_approval_fields" CHECK ((store_approved_by IS NULL) = (store_approved_at IS NULL) AND (head_approved_by IS NULL) = (head_approved_at IS NULL)
    AND (decided_by IS NULL) = (decided_at IS NULL)),
	CONSTRAINT "part_requests_approved_fields" CHECK (status IN ('pending','rejected') OR (store_approved_by IS NOT NULL AND (NOT needs_head_approval OR head_approved_by IS NOT NULL) AND reserve_until IS NOT NULL)
    OR (status = 'cancelled' AND decided_by IS NOT NULL) OR status = 'closed'),
	CONSTRAINT "part_requests_rejected_fields" CHECK (status <> 'rejected' OR (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
	CONSTRAINT "part_requests_note_length" CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_reservations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."stock_reservations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"request_line_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"location_id" bigint NOT NULL,
	"batch_id" bigint,
	"reserved_qty" numeric(18, 4) NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	CONSTRAINT "stock_reservations_quantity_check" CHECK (reserved_qty > 0 AND quantity >= 0 AND quantity <= reserved_qty),
	CONSTRAINT "stock_reservations_release_fields" CHECK ((released_at IS NULL) = (release_reason IS NULL) AND (release_reason IS NULL OR release_reason IN ('issued','cancelled','expired','ticket_closed'))
    AND (released_at IS NULL OR quantity = 0))
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_serials" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."stock_serials_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"serial_no" text NOT NULL,
	"location_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_serials_item_serial_unique" UNIQUE("item_id","serial_no"),
	CONSTRAINT "stock_serials_serial_length" CHECK (char_length(serial_no) BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "inventory"."document_series" DROP CONSTRAINT "document_series_type_check";--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD COLUMN "request_line_id" bigint;--> statement-breakpoint
ALTER TABLE "inventory"."stock_documents" ADD COLUMN "request_id" bigint;--> statement-breakpoint
ALTER TABLE "inventory"."cross_company_grants" ADD CONSTRAINT "cross_company_grants_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."cross_company_grants" ADD CONSTRAINT "cross_company_grants_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."cross_company_grants" ADD CONSTRAINT "cross_company_grants_granted_by_persons_id_fk" FOREIGN KEY ("granted_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."cross_company_grants" ADD CONSTRAINT "cross_company_grants_ended_by_persons_id_fk" FOREIGN KEY ("ended_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."cross_company_grants" ADD CONSTRAINT "cross_company_grants_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_request_lines" ADD CONSTRAINT "part_request_lines_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_request_lines" ADD CONSTRAINT "part_request_lines_request_company_fk" FOREIGN KEY ("request_id","legal_entity_id") REFERENCES "inventory"."part_requests"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_request_lines" ADD CONSTRAINT "part_request_lines_item_company_fk" FOREIGN KEY ("item_id","legal_entity_id") REFERENCES "inventory"."items"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_request_lines" ADD CONSTRAINT "part_request_lines_location_company_fk" FOREIGN KEY ("location_id","legal_entity_id") REFERENCES "inventory"."locations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_requests" ADD CONSTRAINT "part_requests_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_requests" ADD CONSTRAINT "part_requests_requested_by_persons_id_fk" FOREIGN KEY ("requested_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_requests" ADD CONSTRAINT "part_requests_store_approved_by_persons_id_fk" FOREIGN KEY ("store_approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_requests" ADD CONSTRAINT "part_requests_head_approved_by_persons_id_fk" FOREIGN KEY ("head_approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_requests" ADD CONSTRAINT "part_requests_decided_by_persons_id_fk" FOREIGN KEY ("decided_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_requests" ADD CONSTRAINT "part_requests_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."part_requests" ADD CONSTRAINT "part_requests_grant_company_fk" FOREIGN KEY ("grant_id","legal_entity_id") REFERENCES "inventory"."cross_company_grants"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_reservations" ADD CONSTRAINT "stock_reservations_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_reservations" ADD CONSTRAINT "stock_reservations_line_company_fk" FOREIGN KEY ("request_line_id","legal_entity_id") REFERENCES "inventory"."part_request_lines"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_reservations" ADD CONSTRAINT "stock_reservations_item_company_fk" FOREIGN KEY ("item_id","legal_entity_id") REFERENCES "inventory"."items"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_reservations" ADD CONSTRAINT "stock_reservations_location_company_fk" FOREIGN KEY ("location_id","legal_entity_id") REFERENCES "inventory"."locations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_reservations" ADD CONSTRAINT "stock_reservations_batch_item_fk" FOREIGN KEY ("batch_id","item_id","legal_entity_id") REFERENCES "inventory"."stock_batches"("id","item_id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_serials" ADD CONSTRAINT "stock_serials_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_serials" ADD CONSTRAINT "stock_serials_item_company_fk" FOREIGN KEY ("item_id","legal_entity_id") REFERENCES "inventory"."items"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_serials" ADD CONSTRAINT "stock_serials_location_company_fk" FOREIGN KEY ("location_id","legal_entity_id") REFERENCES "inventory"."locations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cross_company_grants_one_open" ON "inventory"."cross_company_grants" USING btree ("person_id","ticket_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_part_requests_ticket" ON "inventory"."part_requests" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_part_requests_company_status" ON "inventory"."part_requests" USING btree ("legal_entity_id","status");--> statement-breakpoint
CREATE INDEX "idx_stock_reservations_line" ON "inventory"."stock_reservations" USING btree ("request_line_id");--> statement-breakpoint
CREATE INDEX "idx_stock_reservations_open" ON "inventory"."stock_reservations" USING btree ("item_id","location_id") WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_stock_serials_location" ON "inventory"."stock_serials" USING btree ("location_id");--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_request_line_company_fk" FOREIGN KEY ("request_line_id","legal_entity_id") REFERENCES "inventory"."part_request_lines"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_documents" ADD CONSTRAINT "stock_documents_request_company_fk" FOREIGN KEY ("request_id","legal_entity_id") REFERENCES "inventory"."part_requests"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."document_series" ADD CONSTRAINT "document_series_type_check" CHECK (doc_type IN ('receipt','issue','return','transfer','reversal','request'));--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_serial_one_unit" CHECK (serial_no IS NULL OR quantity = 1);--> statement-breakpoint
ALTER TABLE "inventory"."stock_documents" ADD CONSTRAINT "stock_documents_request_on_issue" CHECK (request_id IS NULL OR type = 'issue');--> statement-breakpoint
-- Requests, request lines, reservations, grants and serials are never deleted (refuse_delete from migration 0040):
-- requests end with a status, reservations are released, grants are ended, serials move to no location.
CREATE TRIGGER "trg_part_requests_never_deleted" BEFORE DELETE ON "inventory"."part_requests" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_part_request_lines_never_deleted" BEFORE DELETE ON "inventory"."part_request_lines" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_stock_reservations_never_deleted" BEFORE DELETE ON "inventory"."stock_reservations" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_cross_company_grants_never_deleted" BEFORE DELETE ON "inventory"."cross_company_grants" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_stock_serials_never_deleted" BEFORE DELETE ON "inventory"."stock_serials" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
-- Approving part requests (as the store) and granting cross-company requesters: Store in-charge and Inventory controller.
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('inventory.requests.approve', 'inventory', 'Store in-charge: approve, reject and cancel part requests (reserving the stock), and let people from another company request for one ticket (companies you work in; scope all: every company)')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" = 'inventory.requests.approve'
 WHERE r."code" IN ('store_incharge', 'inventory_controller')
ON CONFLICT DO NOTHING;
