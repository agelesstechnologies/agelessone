-- Written first by hand: the statement lines' company-safe key to a passed-on cost needs this unique key to exist.
ALTER TABLE "intercompany"."ic_passed_costs" ADD CONSTRAINT "ic_passed_costs_id_company_unique" UNIQUE("id","legal_entity_id");--> statement-breakpoint
CREATE TABLE "intercompany"."ic_credits" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intercompany"."ic_credits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"line_id" bigint NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"reason" text NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ic_credits_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ic_credits_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "ic_credits_amount_positive" CHECK (amount_minor > 0),
	CONSTRAINT "ic_credits_currency_check" CHECK (currency = 'INR'),
	CONSTRAINT "ic_credits_reason_check" CHECK (char_length(trim(reason)) >= 3)
);
--> statement-breakpoint
CREATE TABLE "intercompany"."ic_statement_line_tickets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intercompany"."ic_statement_line_tickets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"line_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"minutes" integer NOT NULL,
	CONSTRAINT "ic_statement_line_tickets_unique" UNIQUE("line_id","ticket_id"),
	CONSTRAINT "ic_statement_line_tickets_minutes_check" CHECK (minutes > 0)
);
--> statement-breakpoint
CREATE TABLE "intercompany"."ic_statement_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intercompany"."ic_statement_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"statement_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"project_kind" text,
	"project_public_id" uuid,
	"service_type" text,
	"employment_id" bigint,
	"grade" text,
	"minutes" integer,
	"rate_minor" bigint,
	"cost_per_hour_minor" bigint,
	"cost_minor" bigint,
	"amount_minor" bigint NOT NULL,
	"original_amount_minor" bigint,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"passed_cost_id" bigint,
	"credit_id" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"dispute_reason" text,
	"disputed_by" bigint,
	"disputed_at" timestamp with time zone,
	"resolution" text,
	"resolution_reason" text,
	"resolved_by" bigint,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "ic_statement_lines_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ic_statement_lines_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "ic_statement_lines_cost_once" UNIQUE("passed_cost_id"),
	CONSTRAINT "ic_statement_lines_credit_once" UNIQUE("credit_id"),
	CONSTRAINT "ic_statement_lines_kind_check" CHECK (kind IN ('labour','passed_cost','credit')),
	CONSTRAINT "ic_statement_lines_status_check" CHECK (status IN ('pending','accepted','disputed','removed')),
	CONSTRAINT "ic_statement_lines_currency_check" CHECK (currency = 'INR'),
	CONSTRAINT "ic_statement_lines_labour_fields" CHECK ((kind = 'labour') = (employment_id IS NOT NULL AND minutes IS NOT NULL AND rate_minor IS NOT NULL AND service_type IS NOT NULL)
    AND (minutes IS NULL OR minutes > 0) AND (rate_minor IS NULL OR rate_minor >= 0) AND (cost_per_hour_minor IS NULL OR cost_per_hour_minor >= 0)),
	CONSTRAINT "ic_statement_lines_cost_fields" CHECK ((kind = 'passed_cost') = (passed_cost_id IS NOT NULL) AND (kind = 'credit') = (credit_id IS NOT NULL)),
	CONSTRAINT "ic_statement_lines_amount_check" CHECK (CASE WHEN kind = 'credit' THEN amount_minor < 0 ELSE amount_minor >= 0 END),
	CONSTRAINT "ic_statement_lines_project_fields" CHECK ((project_kind IS NULL) = (project_public_id IS NULL) AND (project_kind IS NULL OR project_kind IN ('project','design_request'))),
	CONSTRAINT "ic_statement_lines_service_check" CHECK (service_type IS NULL OR service_type IN ('design','software','iot_hardware','cgi')),
	CONSTRAINT "ic_statement_lines_dispute_fields" CHECK ((dispute_reason IS NULL) = (disputed_by IS NULL) AND (disputed_by IS NULL) = (disputed_at IS NULL)
    AND (dispute_reason IS NULL OR char_length(trim(dispute_reason)) >= 3)),
	CONSTRAINT "ic_statement_lines_resolution_fields" CHECK ((resolution IS NULL) = (resolution_reason IS NULL) AND (resolution IS NULL) = (resolved_by IS NULL)
    AND (resolution IS NULL) = (resolved_at IS NULL) AND (resolution IS NULL OR (resolution IN ('corrected','removed','explained') AND disputed_at IS NOT NULL))
    AND (resolution_reason IS NULL OR char_length(trim(resolution_reason)) >= 3)),
	CONSTRAINT "ic_statement_lines_removed_check" CHECK (status <> 'removed' OR resolution = 'removed'),
	CONSTRAINT "ic_statement_lines_original_check" CHECK (original_amount_minor IS NULL OR resolution IN ('corrected','removed'))
);
--> statement-breakpoint
CREATE TABLE "intercompany"."ic_statements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intercompany"."ic_statements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"prepared_by" bigint NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" bigint,
	"approved_at" timestamp with time zone,
	"approved_as" text,
	"first_sent_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"sent_by" bigint,
	"review_due_on" date,
	"accepted_at" timestamp with time zone,
	"accepted_as" text,
	"accepted_by" bigint,
	"invoice_number" text,
	"invoiced_on" date,
	"invoiced_by" bigint,
	"paid_on" date,
	"payment_ref" text,
	"closed_by" bigint,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ic_statements_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ic_statements_agreement_month_unique" UNIQUE("agreement_id","year","month"),
	CONSTRAINT "ic_statements_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "ic_statements_month_check" CHECK (month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2100),
	CONSTRAINT "ic_statements_status_check" CHECK (status IN ('draft','approved_by_provider','sent','partly_disputed','accepted','invoiced','closed')),
	CONSTRAINT "ic_statements_currency_check" CHECK (currency = 'INR'),
	CONSTRAINT "ic_statements_approved_fields" CHECK ((status = 'draft') = (approved_by IS NULL) AND (approved_by IS NULL) = (approved_at IS NULL)
    AND (approved_by IS NULL) = (approved_as IS NULL) AND (approved_as IS NULL OR approved_as IN ('head','ceo'))),
	CONSTRAINT "ic_statements_not_own_approval" CHECK (approved_by IS NULL OR approved_by <> prepared_by),
	CONSTRAINT "ic_statements_sent_fields" CHECK ((status IN ('draft','approved_by_provider')) = (first_sent_at IS NULL) AND (first_sent_at IS NULL) = (sent_at IS NULL)
    AND (sent_at IS NULL) = (sent_by IS NULL) AND (sent_at IS NULL) = (review_due_on IS NULL) AND (first_sent_at IS NULL) = (round = 0) AND round >= 0),
	CONSTRAINT "ic_statements_accepted_fields" CHECK ((status IN ('accepted','invoiced','closed')) = (accepted_at IS NOT NULL) AND (accepted_at IS NULL) = (accepted_as IS NULL)
    AND (accepted_as IS NULL OR (accepted_as IN ('receiver','automatic') AND (accepted_as = 'automatic') = (accepted_by IS NULL)))),
	CONSTRAINT "ic_statements_invoice_fields" CHECK ((status IN ('invoiced','closed')) = (invoice_number IS NOT NULL) AND (invoice_number IS NULL) = (invoiced_on IS NULL)
    AND (invoice_number IS NULL) = (invoiced_by IS NULL)),
	CONSTRAINT "ic_statements_closed_fields" CHECK ((status = 'closed') = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (paid_on IS NULL)
    AND (closed_at IS NULL) = (payment_ref IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL))
);
--> statement-breakpoint
ALTER TABLE "intercompany"."ic_ticket_billing" ADD COLUMN "service_type" text;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_credits" ADD CONSTRAINT "ic_credits_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_credits" ADD CONSTRAINT "ic_credits_agreement_company_fk" FOREIGN KEY ("agreement_id","legal_entity_id") REFERENCES "intercompany"."ic_agreements"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_credits" ADD CONSTRAINT "ic_credits_line_company_fk" FOREIGN KEY ("line_id","legal_entity_id") REFERENCES "intercompany"."ic_statement_lines"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statement_line_tickets" ADD CONSTRAINT "ic_statement_line_tickets_line_company_fk" FOREIGN KEY ("line_id","legal_entity_id") REFERENCES "intercompany"."ic_statement_lines"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statement_line_tickets" ADD CONSTRAINT "ic_statement_line_tickets_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statement_lines" ADD CONSTRAINT "ic_statement_lines_disputed_by_persons_id_fk" FOREIGN KEY ("disputed_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statement_lines" ADD CONSTRAINT "ic_statement_lines_resolved_by_persons_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statement_lines" ADD CONSTRAINT "ic_statement_lines_statement_company_fk" FOREIGN KEY ("statement_id","legal_entity_id") REFERENCES "intercompany"."ic_statements"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statement_lines" ADD CONSTRAINT "ic_statement_lines_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statement_lines" ADD CONSTRAINT "ic_statement_lines_cost_company_fk" FOREIGN KEY ("passed_cost_id","legal_entity_id") REFERENCES "intercompany"."ic_passed_costs"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statement_lines" ADD CONSTRAINT "ic_statement_lines_credit_company_fk" FOREIGN KEY ("credit_id","legal_entity_id") REFERENCES "intercompany"."ic_credits"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statements" ADD CONSTRAINT "ic_statements_prepared_by_persons_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statements" ADD CONSTRAINT "ic_statements_approved_by_persons_id_fk" FOREIGN KEY ("approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statements" ADD CONSTRAINT "ic_statements_sent_by_persons_id_fk" FOREIGN KEY ("sent_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statements" ADD CONSTRAINT "ic_statements_accepted_by_persons_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statements" ADD CONSTRAINT "ic_statements_invoiced_by_persons_id_fk" FOREIGN KEY ("invoiced_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statements" ADD CONSTRAINT "ic_statements_closed_by_persons_id_fk" FOREIGN KEY ("closed_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statements" ADD CONSTRAINT "ic_statements_agreement_company_fk" FOREIGN KEY ("agreement_id","legal_entity_id") REFERENCES "intercompany"."ic_agreements"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ic_credits_agreement" ON "intercompany"."ic_credits" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "idx_ic_statement_line_tickets_ticket" ON "intercompany"."ic_statement_line_tickets" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_ic_statement_lines_statement" ON "intercompany"."ic_statement_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ic_statements_invoice_number_unique" ON "intercompany"."ic_statements" USING btree ("legal_entity_id","invoice_number") WHERE invoice_number IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_ic_statements_review" ON "intercompany"."ic_statements" USING btree ("status","review_due_on");--> statement-breakpoint
ALTER TABLE "intercompany"."ic_ticket_billing" ADD CONSTRAINT "ic_ticket_billing_service_check" CHECK (service_type IS NULL OR service_type IN ('design','software','iot_hardware','cgi'));--> statement-breakpoint
-- Written by hand below. A statement is never deleted; its agreement and month never change; it never goes back to draft;
-- its preparer changes only while a draft; a closed statement never changes.
CREATE FUNCTION "intercompany"."guard_statement"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IC_NO_DELETE: statements are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.tenant_id, NEW.public_id, NEW.agreement_id, NEW.legal_entity_id, NEW.year, NEW.month, NEW.currency, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.public_id, OLD.agreement_id, OLD.legal_entity_id, OLD.year, OLD.month, OLD.currency, OLD.created_at)
     OR OLD.status = 'closed' OR (OLD.status <> 'draft' AND (NEW.status = 'draft'
       OR (NEW.prepared_by, NEW.prepared_at) IS DISTINCT FROM (OLD.prepared_by, OLD.prepared_at))) THEN
    RAISE EXCEPTION 'IC_STATEMENT_FROZEN: the statement % cannot change that way', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ic_statements_guard" BEFORE UPDATE OR DELETE ON "intercompany"."ic_statements"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."guard_statement"();--> statement-breakpoint
-- Lines are added and removed only while their statement is a draft. Afterwards a line only gets the receiver's answer
-- and the provider's correction (the amount only goes down) or explanation.
CREATE FUNCTION "intercompany"."guard_statement_line"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM "intercompany"."ic_statements" WHERE id = coalesce(NEW.statement_id, OLD.statement_id);
  IF TG_OP IN ('INSERT', 'DELETE') THEN
    IF st <> 'draft' THEN
      RAISE EXCEPTION 'IC_STATEMENT_FROZEN: lines are added or removed only while the statement is a draft' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN coalesce(NEW, OLD);
  END IF;
  IF (NEW.tenant_id, NEW.public_id, NEW.statement_id, NEW.legal_entity_id, NEW.kind, NEW.description, NEW.project_kind, NEW.project_public_id,
      NEW.service_type, NEW.employment_id, NEW.grade, NEW.minutes, NEW.rate_minor, NEW.cost_per_hour_minor, NEW.cost_minor, NEW.currency,
      NEW.passed_cost_id, NEW.credit_id)
     IS DISTINCT FROM (OLD.tenant_id, OLD.public_id, OLD.statement_id, OLD.legal_entity_id, OLD.kind, OLD.description, OLD.project_kind, OLD.project_public_id,
      OLD.service_type, OLD.employment_id, OLD.grade, OLD.minutes, OLD.rate_minor, OLD.cost_per_hour_minor, OLD.cost_minor, OLD.currency,
      OLD.passed_cost_id, OLD.credit_id)
     OR NEW.amount_minor > OLD.amount_minor THEN
    RAISE EXCEPTION 'IC_STATEMENT_FROZEN: a statement line only gets an answer, a lower amount or an explanation' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ic_statement_lines_guard" BEFORE INSERT OR UPDATE OR DELETE ON "intercompany"."ic_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."guard_statement_line"();--> statement-breakpoint
-- A line's tickets are written with it (draft only) and never changed.
CREATE FUNCTION "intercompany"."guard_statement_line_ticket"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT s.status INTO st FROM "intercompany"."ic_statement_lines" l JOIN "intercompany"."ic_statements" s ON s.id = l.statement_id
   WHERE l.id = coalesce(NEW.line_id, OLD.line_id);
  IF TG_OP = 'UPDATE' OR st <> 'draft' THEN
    RAISE EXCEPTION 'IC_STATEMENT_FROZEN: a line''s tickets are written only while the statement is a draft' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ic_statement_line_tickets_guard" BEFORE INSERT OR UPDATE OR DELETE ON "intercompany"."ic_statement_line_tickets"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."guard_statement_line_ticket"();--> statement-breakpoint
-- Credits (corrections after invoicing) are append-only.
CREATE TRIGGER "trg_ic_credits_append_only" BEFORE UPDATE OR DELETE ON "intercompany"."ic_credits"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."forbid_change"();
