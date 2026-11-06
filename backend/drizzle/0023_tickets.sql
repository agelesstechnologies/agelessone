CREATE TABLE "tickets"."number_series" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."number_series_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"prefix" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_series_legal_entity_id_unique" UNIQUE("legal_entity_id"),
	CONSTRAINT "number_series_prefix_format" CHECK (prefix ~ '^[A-Z0-9]{1,10}$'),
	CONSTRAINT "number_series_next_positive" CHECK (next_number >= 1)
);
--> statement-breakpoint
CREATE TABLE "tickets"."reassign_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."reassign_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"from_employment_id" bigint NOT NULL,
	"requested_by" bigint NOT NULL,
	"reason" text NOT NULL,
	"approver_person_id" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"new_employment_id" bigint,
	"decided_by" bigint,
	"decided_as" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reassign_requests_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "reassign_requests_status_check" CHECK (status IN ('pending','approved','rejected')),
	CONSTRAINT "reassign_requests_not_own_decision" CHECK (decided_by IS NULL OR decided_by <> requested_by),
	CONSTRAINT "reassign_requests_not_own_approver" CHECK (approver_person_id IS NULL OR approver_person_id <> requested_by),
	CONSTRAINT "reassign_requests_decided_fields" CHECK ((status = 'pending') = (decided_at IS NULL AND decided_by IS NULL AND decided_as IS NULL)),
	CONSTRAINT "reassign_requests_approved_has_person" CHECK (status <> 'approved' OR new_employment_id IS NOT NULL),
	CONSTRAINT "reassign_requests_rejected_has_reason" CHECK (status <> 'rejected' OR decision_reason IS NOT NULL),
	CONSTRAINT "reassign_requests_decided_as_check" CHECK (decided_as IS NULL OR decided_as IN ('approver','management'))
);
--> statement-breakpoint
CREATE TABLE "tickets"."ticket_assignees" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_assignees_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"assigned_by" bigint NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_by" bigint,
	"ended_at" timestamp with time zone,
	CONSTRAINT "ticket_assignees_ended_fields" CHECK ((ended_by IS NULL) = (ended_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "tickets"."ticket_attachments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_attachments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"file_path" text NOT NULL,
	"file_type" text NOT NULL,
	"uploaded_by" bigint NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_attachments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ticket_attachments_id_ticket_unique" UNIQUE("id","ticket_id"),
	CONSTRAINT "ticket_attachments_kind_check" CHECK (kind IN ('photo','file','signoff')),
	CONSTRAINT "ticket_attachments_type_check" CHECK (file_type IN ('jpg','png','pdf'))
);
--> statement-breakpoint
CREATE TABLE "tickets"."ticket_checklist_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_checklist_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"item" text NOT NULL,
	"result" text NOT NULL,
	"note" text,
	"checked_by" bigint NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_checklist_result_check" CHECK (result IN ('pass','fail','na'))
);
--> statement-breakpoint
CREATE TABLE "tickets"."ticket_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"actor_person_id" bigint,
	"action" text NOT NULL,
	"details" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets"."ticket_links" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"from_ticket_id" bigint NOT NULL,
	"to_ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_links_unique" UNIQUE("from_ticket_id","to_ticket_id","kind"),
	CONSTRAINT "ticket_links_kind_check" CHECK (kind IN ('follows','rework_of')),
	CONSTRAINT "ticket_links_not_self" CHECK (from_ticket_id <> to_ticket_id)
);
--> statement-breakpoint
CREATE TABLE "tickets"."ticket_signoffs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_signoffs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"signer_name" text NOT NULL,
	"signer_role" text,
	"signed_at" timestamp with time zone NOT NULL,
	"photo_attachment_id" bigint NOT NULL,
	"recorded_by" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_signoffs_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ALTER COLUMN "priority" SET DEFAULT 3;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ALTER COLUMN "status" SET DEFAULT 'open';--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ALTER COLUMN "description" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "legal_entity_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "type_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "type_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "type_details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "site" text;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "project_id" bigint;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "department_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "supervisor_person_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "required_skill_id" bigint;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "head_approved_by" bigint;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "head_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Unique keys first: the company-safe foreign keys below point at them.
ALTER TABLE "hrms"."skills" ADD CONSTRAINT "skills_id_company_unique" UNIQUE("id","legal_entity_id");--> statement-breakpoint
ALTER TABLE "tickets"."ticket_types" ADD CONSTRAINT "ticket_types_id_version_company_unique" UNIQUE("id","version","legal_entity_id");--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_company_number_unique" UNIQUE("legal_entity_id","number");--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_id_company_unique" UNIQUE("id","legal_entity_id");--> statement-breakpoint
ALTER TABLE "tickets"."number_series" ADD CONSTRAINT "number_series_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."number_series" ADD CONSTRAINT "number_series_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."reassign_requests" ADD CONSTRAINT "reassign_requests_requested_by_persons_id_fk" FOREIGN KEY ("requested_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."reassign_requests" ADD CONSTRAINT "reassign_requests_approver_person_id_persons_id_fk" FOREIGN KEY ("approver_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."reassign_requests" ADD CONSTRAINT "reassign_requests_decided_by_persons_id_fk" FOREIGN KEY ("decided_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."reassign_requests" ADD CONSTRAINT "reassign_requests_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."reassign_requests" ADD CONSTRAINT "reassign_requests_from_company_fk" FOREIGN KEY ("from_employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."reassign_requests" ADD CONSTRAINT "reassign_requests_new_company_fk" FOREIGN KEY ("new_employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_assignees" ADD CONSTRAINT "ticket_assignees_assigned_by_persons_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_assignees" ADD CONSTRAINT "ticket_assignees_ended_by_persons_id_fk" FOREIGN KEY ("ended_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_assignees" ADD CONSTRAINT "ticket_assignees_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_assignees" ADD CONSTRAINT "ticket_assignees_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_attachments" ADD CONSTRAINT "ticket_attachments_uploaded_by_persons_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_checklist_results" ADD CONSTRAINT "ticket_checklist_results_checked_by_persons_id_fk" FOREIGN KEY ("checked_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_checklist_results" ADD CONSTRAINT "ticket_checklist_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_events" ADD CONSTRAINT "ticket_events_actor_person_id_persons_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_events" ADD CONSTRAINT "ticket_events_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_links" ADD CONSTRAINT "ticket_links_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_links" ADD CONSTRAINT "ticket_links_from_company_fk" FOREIGN KEY ("from_ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_links" ADD CONSTRAINT "ticket_links_to_company_fk" FOREIGN KEY ("to_ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_signoffs" ADD CONSTRAINT "ticket_signoffs_recorded_by_persons_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_signoffs" ADD CONSTRAINT "ticket_signoffs_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_signoffs" ADD CONSTRAINT "ticket_signoffs_photo_same_ticket_fk" FOREIGN KEY ("photo_attachment_id","ticket_id") REFERENCES "tickets"."ticket_attachments"("id","ticket_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reassign_requests_one_pending" ON "tickets"."reassign_requests" USING btree ("ticket_id","from_employment_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_reassign_requests_approver" ON "tickets"."reassign_requests" USING btree ("approver_person_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_assignees_one_current" ON "tickets"."ticket_assignees" USING btree ("ticket_id","employment_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_assignees_one_primary" ON "tickets"."ticket_assignees" USING btree ("ticket_id") WHERE is_primary AND ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_ticket_assignees_employment" ON "tickets"."ticket_assignees" USING btree ("employment_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_attachments_ticket" ON "tickets"."ticket_attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_checklist_ticket" ON "tickets"."ticket_checklist_results" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_events_ticket" ON "tickets"."ticket_events" USING btree ("ticket_id","id");--> statement-breakpoint
CREATE INDEX "idx_ticket_links_to" ON "tickets"."ticket_links" USING btree ("to_ticket_id");--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_supervisor_person_id_persons_id_fk" FOREIGN KEY ("supervisor_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_head_approved_by_persons_id_fk" FOREIGN KEY ("head_approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_type_version_company_fk" FOREIGN KEY ("type_id","type_version","legal_entity_id") REFERENCES "tickets"."ticket_types"("id","version","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_department_company_fk" FOREIGN KEY ("department_id","legal_entity_id") REFERENCES "hrms"."departments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_skill_company_fk" FOREIGN KEY ("required_skill_id","legal_entity_id") REFERENCES "hrms"."skills"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tickets_company_status" ON "tickets"."tickets" USING btree ("legal_entity_id","status");--> statement-breakpoint
CREATE INDEX "idx_tickets_department" ON "tickets"."tickets" USING btree ("department_id");--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_status_check" CHECK (status IN ('open','assigned','in_progress','on_hold','completed','cancelled'));--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_priority_check" CHECK (priority BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_description_length" CHECK (description IS NULL OR length(description) <= 1000);--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_details_object" CHECK (jsonb_typeof(type_details) = 'object');--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_hold_has_reason" CHECK (status <> 'on_hold' OR hold_reason IS NOT NULL);--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_cancel_has_reason" CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL);--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_completed_fields" CHECK ((status = 'completed') = (completed_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_head_approval_fields" CHECK ((head_approved_by IS NULL) = (head_approved_at IS NULL));--> statement-breakpoint
-- The timeline, checklist answers, files, sign-offs and links are append-only.
CREATE FUNCTION "tickets"."forbid_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TICKETS_APPEND_ONLY: % rows cannot be changed or deleted (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ticket_events_append_only" BEFORE UPDATE OR DELETE ON "tickets"."ticket_events"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_ticket_checklist_append_only" BEFORE UPDATE OR DELETE ON "tickets"."ticket_checklist_results"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_ticket_attachments_append_only" BEFORE UPDATE OR DELETE ON "tickets"."ticket_attachments"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_ticket_signoffs_append_only" BEFORE UPDATE OR DELETE ON "tickets"."ticket_signoffs"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_ticket_links_append_only" BEFORE UPDATE OR DELETE ON "tickets"."ticket_links"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_change"();--> statement-breakpoint
-- Tickets, assignments and reassignment requests change but are never deleted.
CREATE FUNCTION "tickets"."forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TICKETS_NEVER_DELETED: % rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_tickets_never_deleted" BEFORE DELETE ON "tickets"."tickets"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_ticket_assignees_never_deleted" BEFORE DELETE ON "tickets"."ticket_assignees"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_reassign_requests_never_deleted" BEFORE DELETE ON "tickets"."reassign_requests"
  FOR EACH ROW EXECUTE FUNCTION "tickets"."forbid_delete"();--> statement-breakpoint
-- Once anyone is assigned, exactly one current assignee is primary (checked when the transaction commits).
CREATE FUNCTION "tickets"."check_one_primary"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n_current int; n_primary int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE is_primary) INTO n_current, n_primary
    FROM "tickets"."ticket_assignees" WHERE ticket_id = NEW.ticket_id AND ended_at IS NULL;
  IF n_current > 0 AND n_primary <> 1 THEN
    RAISE EXCEPTION 'TICKETS_ONE_PRIMARY: a ticket with assignees has exactly one primary (found %)', n_primary USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_ticket_assignees_one_primary" AFTER INSERT OR UPDATE ON "tickets"."ticket_assignees"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "tickets"."check_one_primary"();--> statement-breakpoint
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('tickets.view',             'tickets', 'See tickets: own = where you are an assignee; team = also your departments and the tickets you supervise; all = every ticket'),
  ('tickets.work',             'tickets', 'Work on tickets you are assigned to: start, checklist, files, sign-off, daily updates, ask for reassignment; complete as primary'),
  ('tickets.manage',           'tickets', 'Create and run tickets: scope all (admin user, Management) every ticket; otherwise a department head for their departments'),
  ('tickets.numbering.manage', 'tickets', 'Set each company''s ticket number prefix and next number');
