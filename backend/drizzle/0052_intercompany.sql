CREATE SCHEMA "intercompany";
--> statement-breakpoint
CREATE TABLE "intercompany"."ic_agreements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intercompany"."ic_agreements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"receiver_legal_entity_id" bigint NOT NULL,
	"services" text[] NOT NULL,
	"pricing_method" text NOT NULL,
	"cost_plus_percent" numeric(5, 2),
	"passed_cost_handling" text DEFAULT 'at_cost' NOT NULL,
	"passed_cost_percent" numeric(5, 2),
	"review_days" integer NOT NULL,
	"payment_terms_days" integer NOT NULL,
	"provider_head_employment_id" bigint NOT NULL,
	"provider_approver_employment_id" bigint NOT NULL,
	"receiver_head_employment_id" bigint NOT NULL,
	"receiver_approver_employment_id" bigint NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone,
	CONSTRAINT "ic_agreements_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ic_agreements_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "ic_agreements_two_companies" CHECK (legal_entity_id <> receiver_legal_entity_id),
	CONSTRAINT "ic_agreements_services_check" CHECK (cardinality(services) BETWEEN 1 AND 4 AND services <@ ARRAY['design','software','iot_hardware','cgi']::text[]),
	CONSTRAINT "ic_agreements_pricing_check" CHECK (pricing_method IN ('rate_card','cost_plus')),
	CONSTRAINT "ic_agreements_cost_plus_fields" CHECK ((pricing_method = 'cost_plus') = (cost_plus_percent IS NOT NULL) AND (cost_plus_percent IS NULL OR cost_plus_percent BETWEEN 0 AND 100)),
	CONSTRAINT "ic_agreements_passed_cost_check" CHECK (passed_cost_handling IN ('at_cost','percent')),
	CONSTRAINT "ic_agreements_passed_cost_fields" CHECK ((passed_cost_handling = 'percent') = (passed_cost_percent IS NOT NULL) AND (passed_cost_percent IS NULL OR passed_cost_percent BETWEEN 0 AND 100)),
	CONSTRAINT "ic_agreements_days_check" CHECK (review_days BETWEEN 1 AND 60 AND payment_terms_days BETWEEN 0 AND 365),
	CONSTRAINT "ic_agreements_status_check" CHECK (status IN ('draft','active','ended')),
	CONSTRAINT "ic_agreements_end_fields" CHECK ((status = 'ended') = (end_date IS NOT NULL) AND (end_date IS NULL OR end_date >= start_date)),
	CONSTRAINT "ic_agreements_updated_fields" CHECK ((updated_by IS NULL) = (updated_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "intercompany"."ic_billed_months" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intercompany"."ic_billed_months_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"agreement_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"billed_by" bigint NOT NULL,
	"billed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ic_billed_months_agreement_month_unique" UNIQUE("agreement_id","year","month"),
	CONSTRAINT "ic_billed_months_month_check" CHECK (month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2100)
);
--> statement-breakpoint
CREATE TABLE "intercompany"."ic_passed_costs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intercompany"."ic_passed_costs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"agreement_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"project_public_id" uuid,
	"description" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"incurred_on" date NOT NULL,
	"bill_path" text,
	"bill_type" text,
	"bill_uploaded_by" bigint,
	"bill_uploaded_at" timestamp with time zone,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ic_passed_costs_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ic_passed_costs_amount_positive" CHECK (amount_minor > 0),
	CONSTRAINT "ic_passed_costs_currency_check" CHECK (currency = 'INR'),
	CONSTRAINT "ic_passed_costs_description_length" CHECK (char_length(description) BETWEEN 3 AND 300),
	CONSTRAINT "ic_passed_costs_bill_fields" CHECK ((bill_path IS NULL) = (bill_type IS NULL) AND (bill_path IS NULL) = (bill_uploaded_by IS NULL) AND (bill_path IS NULL) = (bill_uploaded_at IS NULL)),
	CONSTRAINT "ic_passed_costs_bill_type_check" CHECK (bill_type IS NULL OR bill_type IN ('jpg','png','pdf'))
);
--> statement-breakpoint
CREATE TABLE "intercompany"."ic_rate_cards" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intercompany"."ic_rate_cards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"agreement_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"service_type" text,
	"grade" text,
	"rate_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ic_rate_cards_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ic_rate_cards_item_from_unique" UNIQUE NULLS NOT DISTINCT("agreement_id","service_type","grade","effective_from"),
	CONSTRAINT "ic_rate_cards_item_check" CHECK ((service_type IS NULL) <> (grade IS NULL)),
	CONSTRAINT "ic_rate_cards_service_check" CHECK (service_type IS NULL OR service_type IN ('design','software','iot_hardware','cgi')),
	CONSTRAINT "ic_rate_cards_grade_check" CHECK (grade IS NULL OR char_length(grade) BETWEEN 1 AND 40),
	CONSTRAINT "ic_rate_cards_rate_positive" CHECK (rate_minor > 0),
	CONSTRAINT "ic_rate_cards_currency_check" CHECK (currency = 'INR')
);
--> statement-breakpoint
CREATE TABLE "intercompany"."ic_ticket_billing" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intercompany"."ic_ticket_billing_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"billable_to_legal_entity_id" bigint NOT NULL,
	"link_kind" text NOT NULL,
	"link_public_id" uuid NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"not_billable_reason" text,
	"changed_by" bigint NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ic_ticket_billing_ticket_id_unique" UNIQUE("ticket_id"),
	CONSTRAINT "ic_ticket_billing_other_company" CHECK (billable_to_legal_entity_id <> legal_entity_id),
	CONSTRAINT "ic_ticket_billing_link_kind_check" CHECK (link_kind IN ('project','design_request')),
	CONSTRAINT "ic_ticket_billing_reason_check" CHECK (billable = (not_billable_reason IS NULL) AND (not_billable_reason IS NULL OR char_length(trim(not_billable_reason)) >= 3))
);
--> statement-breakpoint
ALTER TABLE "intercompany"."ic_agreements" ADD CONSTRAINT "ic_agreements_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_agreements" ADD CONSTRAINT "ic_agreements_receiver_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("receiver_legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_agreements" ADD CONSTRAINT "ic_agreements_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_agreements" ADD CONSTRAINT "ic_agreements_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_agreements" ADD CONSTRAINT "ic_agreements_provider_head_company_fk" FOREIGN KEY ("provider_head_employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_agreements" ADD CONSTRAINT "ic_agreements_provider_approver_company_fk" FOREIGN KEY ("provider_approver_employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_agreements" ADD CONSTRAINT "ic_agreements_receiver_head_company_fk" FOREIGN KEY ("receiver_head_employment_id","receiver_legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_agreements" ADD CONSTRAINT "ic_agreements_receiver_approver_company_fk" FOREIGN KEY ("receiver_approver_employment_id","receiver_legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_billed_months" ADD CONSTRAINT "ic_billed_months_billed_by_persons_id_fk" FOREIGN KEY ("billed_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_billed_months" ADD CONSTRAINT "ic_billed_months_agreement_company_fk" FOREIGN KEY ("agreement_id","legal_entity_id") REFERENCES "intercompany"."ic_agreements"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_passed_costs" ADD CONSTRAINT "ic_passed_costs_bill_uploaded_by_persons_id_fk" FOREIGN KEY ("bill_uploaded_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_passed_costs" ADD CONSTRAINT "ic_passed_costs_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_passed_costs" ADD CONSTRAINT "ic_passed_costs_agreement_company_fk" FOREIGN KEY ("agreement_id","legal_entity_id") REFERENCES "intercompany"."ic_agreements"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_rate_cards" ADD CONSTRAINT "ic_rate_cards_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_rate_cards" ADD CONSTRAINT "ic_rate_cards_agreement_company_fk" FOREIGN KEY ("agreement_id","legal_entity_id") REFERENCES "intercompany"."ic_agreements"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_ticket_billing" ADD CONSTRAINT "ic_ticket_billing_billable_to_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("billable_to_legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_ticket_billing" ADD CONSTRAINT "ic_ticket_billing_changed_by_persons_id_fk" FOREIGN KEY ("changed_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_ticket_billing" ADD CONSTRAINT "ic_ticket_billing_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ic_agreements_one_active" ON "intercompany"."ic_agreements" USING btree ("legal_entity_id","receiver_legal_entity_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_ic_agreements_receiver" ON "intercompany"."ic_agreements" USING btree ("receiver_legal_entity_id");--> statement-breakpoint
CREATE INDEX "idx_ic_passed_costs_agreement_date" ON "intercompany"."ic_passed_costs" USING btree ("agreement_id","incurred_on");--> statement-breakpoint
CREATE INDEX "idx_ic_ticket_billing_receiver" ON "intercompany"."ic_ticket_billing" USING btree ("legal_entity_id","billable_to_legal_entity_id");--> statement-breakpoint
-- Written by hand below. Rate cards and billed months are never changed or deleted: a new rate is a new row.
CREATE FUNCTION "intercompany"."forbid_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IC_APPEND_ONLY: % rows are never changed or deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ic_rate_cards_append_only" BEFORE UPDATE OR DELETE ON "intercompany"."ic_rate_cards"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_ic_billed_months_append_only" BEFORE UPDATE OR DELETE ON "intercompany"."ic_billed_months"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."forbid_change"();--> statement-breakpoint
-- Nothing is deleted (agreements, passed-on costs, ticket billing).
CREATE FUNCTION "intercompany"."forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IC_NO_DELETE: % rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ic_ticket_billing_no_delete" BEFORE DELETE ON "intercompany"."ic_ticket_billing"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."forbid_delete"();--> statement-breakpoint
-- An agreement keeps its companies, and an ended agreement never changes.
CREATE FUNCTION "intercompany"."guard_agreement"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IC_NO_DELETE: agreements are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'ended' OR (NEW.tenant_id, NEW.public_id, NEW.legal_entity_id, NEW.receiver_legal_entity_id, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM (OLD.tenant_id, OLD.public_id, OLD.legal_entity_id, OLD.receiver_legal_entity_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'IC_AGREEMENT_FROZEN: an ended agreement and the companies of an agreement never change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ic_agreements_guard" BEFORE UPDATE OR DELETE ON "intercompany"."ic_agreements"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."guard_agreement"();--> statement-breakpoint
-- A new rate never reaches back into a billed month (it would change what was billed).
CREATE FUNCTION "intercompany"."guard_rate_card"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "intercompany"."ic_billed_months" b
              WHERE b.agreement_id = NEW.agreement_id AND (make_date(b.year, b.month, 1) + interval '1 month')::date > NEW.effective_from) THEN
    RAISE EXCEPTION 'IC_MONTH_BILLED: a rate from % would change a billed month', NEW.effective_from USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ic_rate_cards_billed" BEFORE INSERT ON "intercompany"."ic_rate_cards"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."guard_rate_card"();--> statement-breakpoint
-- A passed-on cost: never deleted; only its bill can be attached (or replaced); nothing in a billed month changes.
CREATE FUNCTION "intercompany"."guard_passed_cost"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IC_NO_DELETE: passed-on costs are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.public_id, NEW.agreement_id, NEW.legal_entity_id, NEW.project_public_id, NEW.description,
      NEW.amount_minor, NEW.currency, NEW.incurred_on, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM (OLD.tenant_id, OLD.public_id, OLD.agreement_id, OLD.legal_entity_id, OLD.project_public_id, OLD.description,
      OLD.amount_minor, OLD.currency, OLD.incurred_on, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'IC_COST_FROZEN: only the bill of a passed-on cost can change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "intercompany"."ic_billed_months" b WHERE b.agreement_id = NEW.agreement_id
              AND b.year = extract(year FROM NEW.incurred_on) AND b.month = extract(month FROM NEW.incurred_on)) THEN
    RAISE EXCEPTION 'IC_MONTH_BILLED: % is billed and cannot change', to_char(NEW.incurred_on, 'YYYY-MM') USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ic_passed_costs_guard" BEFORE INSERT OR UPDATE OR DELETE ON "intercompany"."ic_passed_costs"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."guard_passed_cost"();--> statement-breakpoint
-- Who may do what. Company heads need no permission: they are named on the agreement (as a department head is set on
-- the department). The CEO sees and manages every agreement through these, held with scope all (role Management).
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('intercompany.view',   'intercompany', 'See every intercompany agreement, its rates, billed months, passed-on costs and ticket billing (scope all)'),
  ('intercompany.manage', 'intercompany', 'Create and change intercompany agreements, add rates, mark months billed, record passed-on costs and set any ticket (not) billable (scope all)')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- existing databases: the Management role (the CEO) gets them (new databases get them from the seed too)
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" IN ('intercompany.view', 'intercompany.manage')
 WHERE r."code" = 'management'
ON CONFLICT DO NOTHING;
