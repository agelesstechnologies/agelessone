CREATE TABLE "core"."outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer NOT NULL,
	"aggregate_public_id" uuid NOT NULL,
	"caused_by" uuid,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "outbox_event_type_format" CHECK (event_type ~ '^[a-z]+([.][a-z_]+)+$'),
	CONSTRAINT "outbox_event_version_check" CHECK (event_version >= 1)
);
--> statement-breakpoint
CREATE TABLE "inventory"."document_series" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."document_series_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"doc_type" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "document_series_company_type_unique" UNIQUE("legal_entity_id","doc_type"),
	CONSTRAINT "document_series_type_check" CHECK (doc_type IN ('receipt','issue','return','transfer','reversal')),
	CONSTRAINT "document_series_next_check" CHECK (next_number >= 1)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_balances" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."stock_balances_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"location_id" bigint NOT NULL,
	"batch_id" bigint,
	"on_hand" numeric(18, 4) DEFAULT '0' NOT NULL,
	"reserved" numeric(18, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_place_unique" UNIQUE NULLS NOT DISTINCT("legal_entity_id","item_id","location_id","batch_id"),
	CONSTRAINT "stock_balances_on_hand_check" CHECK (on_hand >= 0),
	CONSTRAINT "stock_balances_reserved_check" CHECK (reserved >= 0 AND reserved <= on_hand)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_batches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."stock_batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"batch_no" text NOT NULL,
	"expiry_date" date,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_batches_item_batch_unique" UNIQUE("item_id","batch_no"),
	CONSTRAINT "stock_batches_id_item_company_unique" UNIQUE("id","item_id","legal_entity_id"),
	CONSTRAINT "stock_batches_batch_no_length" CHECK (char_length(batch_no) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_document_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."stock_document_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"document_id" bigint NOT NULL,
	"line_no" integer NOT NULL,
	"item_id" bigint NOT NULL,
	"location_id" bigint NOT NULL,
	"to_location_id" bigint,
	"batch_id" bigint,
	"serial_no" text,
	"quantity" numeric(18, 4) NOT NULL,
	"entered_quantity" numeric(18, 4),
	"entered_unit_id" bigint,
	"unit_cost_minor" numeric(24, 6) NOT NULL,
	"value_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"condition" text,
	"original_line_id" bigint,
	CONSTRAINT "stock_document_lines_document_line_unique" UNIQUE("document_id","line_no"),
	CONSTRAINT "stock_document_lines_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "stock_document_lines_quantity_check" CHECK (quantity > 0 AND (entered_quantity IS NULL OR entered_quantity > 0)),
	CONSTRAINT "stock_document_lines_entered_fields" CHECK ((entered_quantity IS NULL) = (entered_unit_id IS NULL)),
	CONSTRAINT "stock_document_lines_money_check" CHECK (unit_cost_minor >= 0 AND value_minor >= 0 AND currency = 'INR'),
	CONSTRAINT "stock_document_lines_condition_check" CHECK (condition IS NULL OR condition IN ('usable','repair','scrap')),
	CONSTRAINT "stock_document_lines_to_location_check" CHECK (to_location_id IS NULL OR to_location_id <> location_id),
	CONSTRAINT "stock_document_lines_line_no_check" CHECK (line_no >= 1)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_documents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."stock_documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"type" text NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"document_date" date NOT NULL,
	"supplier_name" text,
	"challan_no" text,
	"challan_path" text,
	"challan_type" text,
	"reason" text,
	"note" text,
	"ticket_id" bigint,
	"project_id" bigint,
	"original_document_id" bigint,
	"transit_location_id" bigint,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by" bigint,
	"received_at" timestamp with time zone,
	CONSTRAINT "stock_documents_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "stock_documents_company_number_unique" UNIQUE("legal_entity_id","number"),
	CONSTRAINT "stock_documents_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "stock_documents_type_check" CHECK (type IN ('receipt','issue','return','transfer','reversal')),
	CONSTRAINT "stock_documents_status_check" CHECK (status IN ('posted','in_transit','reversed')),
	CONSTRAINT "stock_documents_currency_check" CHECK (currency = 'INR'),
	CONSTRAINT "stock_documents_receipt_fields" CHECK ((type = 'receipt') = (supplier_name IS NOT NULL) AND (type <> 'receipt' OR reason IS NOT NULL)),
	CONSTRAINT "stock_documents_issue_target" CHECK ((type = 'issue') = (ticket_id IS NOT NULL OR project_id IS NOT NULL)),
	CONSTRAINT "stock_documents_original_fields" CHECK ((type IN ('return','reversal')) = (original_document_id IS NOT NULL) AND (type <> 'reversal' OR reason IS NOT NULL)),
	CONSTRAINT "stock_documents_transit_fields" CHECK ((type = 'transfer') = (transit_location_id IS NOT NULL) AND (status <> 'in_transit' OR type = 'transfer')),
	CONSTRAINT "stock_documents_received_fields" CHECK ((received_by IS NULL) = (received_at IS NULL) AND (received_at IS NULL OR type = 'transfer')),
	CONSTRAINT "stock_documents_challan_fields" CHECK ((challan_path IS NULL) = (challan_type IS NULL) AND (challan_type IS NULL OR challan_type IN ('jpg','png','pdf')) AND (challan_path IS NULL OR type = 'receipt')),
	CONSTRAINT "stock_documents_reversal_final" CHECK (type <> 'reversal' OR status = 'posted'),
	CONSTRAINT "stock_documents_text_lengths" CHECK ((supplier_name IS NULL OR char_length(supplier_name) BETWEEN 2 AND 120) AND (challan_no IS NULL OR char_length(challan_no) BETWEEN 1 AND 60) AND (reason IS NULL OR char_length(reason) BETWEEN 3 AND 300) AND (note IS NULL OR char_length(note) BETWEEN 1 AND 500))
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_moves" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."stock_moves_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"location_id" bigint NOT NULL,
	"batch_id" bigint,
	"serial_no" text,
	"qty_delta" numeric(18, 4) NOT NULL,
	"unit_cost_minor" numeric(24, 6) NOT NULL,
	"value_delta_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"document_id" bigint NOT NULL,
	"document_line_id" bigint NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversal_of" bigint,
	CONSTRAINT "stock_moves_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "stock_moves_qty_check" CHECK (qty_delta <> 0),
	CONSTRAINT "stock_moves_money_check" CHECK (unit_cost_minor >= 0 AND currency = 'INR' AND (value_delta_minor = 0 OR sign(value_delta_minor) = sign(qty_delta)))
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_valuations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory"."stock_valuations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"on_hand" numeric(18, 4) DEFAULT '0' NOT NULL,
	"value_minor" bigint DEFAULT 0 NOT NULL,
	"avg_cost_minor" numeric(24, 6) DEFAULT '0' NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_valuations_item_unique" UNIQUE("item_id"),
	CONSTRAINT "stock_valuations_amounts_check" CHECK (on_hand >= 0 AND value_minor >= 0 AND avg_cost_minor >= 0 AND currency = 'INR'),
	CONSTRAINT "stock_valuations_empty_has_no_value" CHECK (on_hand > 0 OR value_minor = 0)
);
--> statement-breakpoint
ALTER TABLE "core"."outbox" ADD CONSTRAINT "outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."document_series" ADD CONSTRAINT "document_series_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_balances" ADD CONSTRAINT "stock_balances_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_balances" ADD CONSTRAINT "stock_balances_item_company_fk" FOREIGN KEY ("item_id","legal_entity_id") REFERENCES "inventory"."items"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_balances" ADD CONSTRAINT "stock_balances_location_company_fk" FOREIGN KEY ("location_id","legal_entity_id") REFERENCES "inventory"."locations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_balances" ADD CONSTRAINT "stock_balances_batch_item_fk" FOREIGN KEY ("batch_id","item_id","legal_entity_id") REFERENCES "inventory"."stock_batches"("id","item_id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_batches" ADD CONSTRAINT "stock_batches_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_batches" ADD CONSTRAINT "stock_batches_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_batches" ADD CONSTRAINT "stock_batches_item_company_fk" FOREIGN KEY ("item_id","legal_entity_id") REFERENCES "inventory"."items"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_document_company_fk" FOREIGN KEY ("document_id","legal_entity_id") REFERENCES "inventory"."stock_documents"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_item_company_fk" FOREIGN KEY ("item_id","legal_entity_id") REFERENCES "inventory"."items"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_location_company_fk" FOREIGN KEY ("location_id","legal_entity_id") REFERENCES "inventory"."locations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_to_location_company_fk" FOREIGN KEY ("to_location_id","legal_entity_id") REFERENCES "inventory"."locations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_unit_company_fk" FOREIGN KEY ("entered_unit_id","legal_entity_id") REFERENCES "inventory"."units"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_batch_item_fk" FOREIGN KEY ("batch_id","item_id","legal_entity_id") REFERENCES "inventory"."stock_batches"("id","item_id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_document_lines" ADD CONSTRAINT "stock_document_lines_original_company_fk" FOREIGN KEY ("original_line_id","legal_entity_id") REFERENCES "inventory"."stock_document_lines"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_documents" ADD CONSTRAINT "stock_documents_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_documents" ADD CONSTRAINT "stock_documents_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_documents" ADD CONSTRAINT "stock_documents_received_by_persons_id_fk" FOREIGN KEY ("received_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_documents" ADD CONSTRAINT "stock_documents_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_documents" ADD CONSTRAINT "stock_documents_original_company_fk" FOREIGN KEY ("original_document_id","legal_entity_id") REFERENCES "inventory"."stock_documents"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_documents" ADD CONSTRAINT "stock_documents_transit_company_fk" FOREIGN KEY ("transit_location_id","legal_entity_id") REFERENCES "inventory"."locations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_moves" ADD CONSTRAINT "stock_moves_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_moves" ADD CONSTRAINT "stock_moves_item_company_fk" FOREIGN KEY ("item_id","legal_entity_id") REFERENCES "inventory"."items"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_moves" ADD CONSTRAINT "stock_moves_location_company_fk" FOREIGN KEY ("location_id","legal_entity_id") REFERENCES "inventory"."locations"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_moves" ADD CONSTRAINT "stock_moves_batch_item_fk" FOREIGN KEY ("batch_id","item_id","legal_entity_id") REFERENCES "inventory"."stock_batches"("id","item_id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_moves" ADD CONSTRAINT "stock_moves_document_company_fk" FOREIGN KEY ("document_id","legal_entity_id") REFERENCES "inventory"."stock_documents"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_moves" ADD CONSTRAINT "stock_moves_line_company_fk" FOREIGN KEY ("document_line_id","legal_entity_id") REFERENCES "inventory"."stock_document_lines"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_moves" ADD CONSTRAINT "stock_moves_reversal_company_fk" FOREIGN KEY ("reversal_of","legal_entity_id") REFERENCES "inventory"."stock_moves"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_valuations" ADD CONSTRAINT "stock_valuations_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_valuations" ADD CONSTRAINT "stock_valuations_item_company_fk" FOREIGN KEY ("item_id","legal_entity_id") REFERENCES "inventory"."items"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outbox_unpublished" ON "core"."outbox" USING btree ("id") WHERE published_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_outbox_type" ON "core"."outbox" USING btree ("tenant_id","event_type","id");--> statement-breakpoint
CREATE INDEX "idx_stock_balances_location" ON "inventory"."stock_balances" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "idx_stock_document_lines_item" ON "inventory"."stock_document_lines" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "idx_stock_document_lines_original" ON "inventory"."stock_document_lines" USING btree ("original_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_documents_one_reversal" ON "inventory"."stock_documents" USING btree ("original_document_id") WHERE type = 'reversal';--> statement-breakpoint
CREATE INDEX "idx_stock_documents_company_date" ON "inventory"."stock_documents" USING btree ("legal_entity_id","document_date");--> statement-breakpoint
CREATE INDEX "idx_stock_documents_ticket" ON "inventory"."stock_documents" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_moves_reversed_once" ON "inventory"."stock_moves" USING btree ("reversal_of") WHERE reversal_of IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_stock_moves_item_location" ON "inventory"."stock_moves" USING btree ("legal_entity_id","item_id","location_id");--> statement-breakpoint
CREATE INDEX "idx_stock_moves_document" ON "inventory"."stock_moves" USING btree ("document_id");--> statement-breakpoint
-- The stock ledger and document lines are append-only: never updated or deleted. A mistake is undone by a reversal
-- document, which adds opposite moves.
CREATE FUNCTION "inventory"."refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory.% rows are never changed or deleted: post a reversal instead', TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_stock_moves_append_only" BEFORE UPDATE OR DELETE ON "inventory"."stock_moves" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_change"();--> statement-breakpoint
CREATE TRIGGER "trg_stock_document_lines_append_only" BEFORE UPDATE OR DELETE ON "inventory"."stock_document_lines" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_change"();--> statement-breakpoint
-- Documents, balances, valuations, batches and number series are never deleted (refuse_delete from migration 0040).
CREATE TRIGGER "trg_stock_documents_never_deleted" BEFORE DELETE ON "inventory"."stock_documents" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_stock_balances_never_deleted" BEFORE DELETE ON "inventory"."stock_balances" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_stock_valuations_never_deleted" BEFORE DELETE ON "inventory"."stock_valuations" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_stock_batches_never_deleted" BEFORE DELETE ON "inventory"."stock_batches" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_document_series_never_deleted" BEFORE DELETE ON "inventory"."document_series" FOR EACH ROW EXECUTE FUNCTION "inventory"."refuse_delete"();--> statement-breakpoint
-- Outbox events are never deleted, and nothing in them changes except published_at, set once by a consumer.
CREATE FUNCTION "core"."guard_outbox"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'core.outbox events are never deleted'; END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.event_id, NEW.event_type, NEW.event_version, NEW.aggregate_public_id, NEW.caused_by, NEW.payload, NEW.occurred_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.event_id, OLD.event_type, OLD.event_version, OLD.aggregate_public_id, OLD.caused_by, OLD.payload, OLD.occurred_at)
     OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'core.outbox events never change; only published_at is set, once';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_outbox_guard" BEFORE UPDATE OR DELETE ON "core"."outbox" FOR EACH ROW EXECUTE FUNCTION "core"."guard_outbox"();
