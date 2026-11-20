CREATE SCHEMA "design";
--> statement-breakpoint
CREATE TABLE "core"."customers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."customers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" text NOT NULL,
	"legal_entity_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone,
	CONSTRAINT "customers_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "customers_tenant_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "customers_code_format" CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
	CONSTRAINT "customers_name_length" CHECK (char_length(name) BETWEEN 2 AND 200),
	CONSTRAINT "customers_status_check" CHECK (status IN ('active','inactive')),
	CONSTRAINT "customers_updated_fields" CHECK ((updated_by IS NULL) = (updated_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "design"."client_responses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."client_responses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"response" text NOT NULL,
	"comments" text,
	"responded_on" date NOT NULL,
	"responder_name" text NOT NULL,
	"recorded_by" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_responses_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "client_responses_revision_id_unique" UNIQUE("revision_id"),
	CONSTRAINT "client_responses_response_check" CHECK (response IN ('accepted','returned')),
	CONSTRAINT "client_responses_comments_check" CHECK ((response = 'accepted' OR comments IS NOT NULL) AND (comments IS NULL OR char_length(comments) BETWEEN 3 AND 4000)),
	CONSTRAINT "client_responses_responder_length" CHECK (char_length(responder_name) BETWEEN 2 AND 120)
);
--> statement-breakpoint
CREATE TABLE "design"."counters" (
	"tenant_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"series" text NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "counters_pk" PRIMARY KEY("legal_entity_id","series"),
	CONSTRAINT "counters_series_check" CHECK (series IN ('job','transmittal')),
	CONSTRAINT "counters_last_number_check" CHECK (last_number >= 1)
);
--> statement-breakpoint
CREATE TABLE "design"."design_jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."design_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"department_id" bigint NOT NULL,
	"number" text NOT NULL,
	"customer_id" bigint NOT NULL,
	"client_project_reference" text,
	"site" text,
	"scope" text NOT NULL,
	"requirements" text,
	"due_date" date,
	"received_from_name" text NOT NULL,
	"received_from_contact" text,
	"status" text DEFAULT 'received' NOT NULL,
	"hold_reason" text,
	"resume_status" text,
	"cancel_reason" text,
	"client_project_public_id" uuid,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone,
	CONSTRAINT "design_jobs_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "design_jobs_company_number_unique" UNIQUE("legal_entity_id","number"),
	CONSTRAINT "design_jobs_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "design_jobs_status_check" CHECK (status IN ('received','accepted','in_design','on_hold','closed','cancelled')),
	CONSTRAINT "design_jobs_hold_fields" CHECK ((status = 'on_hold') = (hold_reason IS NOT NULL) AND (status = 'on_hold') = (resume_status IS NOT NULL)
    AND (resume_status IS NULL OR resume_status IN ('received','accepted','in_design'))),
	CONSTRAINT "design_jobs_cancel_fields" CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
	CONSTRAINT "design_jobs_reason_length" CHECK ((hold_reason IS NULL OR char_length(hold_reason) BETWEEN 3 AND 500) AND (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 3 AND 500)),
	CONSTRAINT "design_jobs_text_lengths" CHECK (char_length(scope) BETWEEN 3 AND 4000 AND (requirements IS NULL OR char_length(requirements) <= 8000)
    AND (client_project_reference IS NULL OR char_length(client_project_reference) <= 200) AND (site IS NULL OR char_length(site) <= 300)
    AND char_length(received_from_name) BETWEEN 2 AND 120 AND (received_from_contact IS NULL OR char_length(received_from_contact) <= 120)),
	CONSTRAINT "design_jobs_updated_fields" CHECK ((updated_by IS NULL) = (updated_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "design"."drawing_revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."drawing_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"drawing_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"stage" text NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"change_note" text NOT NULL,
	"client_project_reference" text,
	"drawn_by_person_id" bigint NOT NULL,
	"scale" text,
	"sheet" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"submitted_by" bigint,
	"submitted_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "drawing_revisions_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "drawing_revisions_drawing_seq_unique" UNIQUE("drawing_id","seq"),
	CONSTRAINT "drawing_revisions_drawing_code_unique" UNIQUE("drawing_id","code"),
	CONSTRAINT "drawing_revisions_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "drawing_revisions_seq_check" CHECK (seq >= 1),
	CONSTRAINT "drawing_revisions_stage_check" CHECK (stage IN ('preliminary','construction')),
	CONSTRAINT "drawing_revisions_code_format" CHECK ((stage = 'preliminary' AND code ~ '^[A-Z]{1,2}$') OR (stage = 'construction' AND code ~ '^(0|[1-9][0-9]{0,2})$')),
	CONSTRAINT "drawing_revisions_status_check" CHECK (status IN ('draft','submitted','qc_approved','changes_needed','issued','accepted','returned','superseded')),
	CONSTRAINT "drawing_revisions_submitted_fields" CHECK ((submitted_by IS NULL) = (submitted_at IS NULL) AND (status = 'draft') = (submitted_at IS NULL)),
	CONSTRAINT "drawing_revisions_superseded_fields" CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
	CONSTRAINT "drawing_revisions_text_lengths" CHECK (char_length(title) BETWEEN 2 AND 200 AND char_length(change_note) BETWEEN 3 AND 2000
    AND (client_project_reference IS NULL OR char_length(client_project_reference) <= 200) AND (scale IS NULL OR char_length(scale) <= 30) AND (sheet IS NULL OR char_length(sheet) <= 30))
);
--> statement-breakpoint
CREATE TABLE "design"."drawings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."drawings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"job_id" bigint NOT NULL,
	"discipline" text NOT NULL,
	"seq" integer NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone,
	CONSTRAINT "drawings_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "drawings_job_discipline_seq_unique" UNIQUE("job_id","discipline","seq"),
	CONSTRAINT "drawings_company_number_unique" UNIQUE("legal_entity_id","number"),
	CONSTRAINT "drawings_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "drawings_discipline_format" CHECK (discipline ~ '^[A-Z]{2,5}$'),
	CONSTRAINT "drawings_seq_check" CHECK (seq BETWEEN 1 AND 999),
	CONSTRAINT "drawings_title_length" CHECK (char_length(title) BETWEEN 2 AND 200),
	CONSTRAINT "drawings_updated_fields" CHECK ((updated_by IS NULL) = (updated_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "design"."job_attachments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."job_attachments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"job_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"file_path" text NOT NULL,
	"file_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" bigint NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_attachments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "job_attachments_type_check" CHECK (file_type ~ '^[a-z0-9]{1,8}$'),
	CONSTRAINT "job_attachments_size_check" CHECK (size_bytes > 0),
	CONSTRAINT "job_attachments_description_length" CHECK (description IS NULL OR char_length(description) <= 200)
);
--> statement-breakpoint
CREATE TABLE "design"."job_tickets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."job_tickets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"job_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"linked_by" bigint NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_tickets_ticket_id_unique" UNIQUE("ticket_id")
);
--> statement-breakpoint
CREATE TABLE "design"."qc_review_files" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."qc_review_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"review_id" bigint NOT NULL,
	"name" text NOT NULL,
	"file_path" text NOT NULL,
	"file_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_review_files_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "qc_review_files_type_check" CHECK (file_type IN ('pdf','jpg','png')),
	CONSTRAINT "qc_review_files_size_check" CHECK (size_bytes > 0)
);
--> statement-breakpoint
CREATE TABLE "design"."qc_reviews" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."qc_reviews_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"reviewer_person_id" bigint NOT NULL,
	"decision" text NOT NULL,
	"comments" text,
	"checklist" jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_reviews_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "qc_reviews_revision_id_unique" UNIQUE("revision_id"),
	CONSTRAINT "qc_reviews_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "qc_reviews_decision_check" CHECK (decision IN ('approved','changes_needed')),
	CONSTRAINT "qc_reviews_comments_check" CHECK ((decision = 'approved' OR comments IS NOT NULL) AND (comments IS NULL OR char_length(comments) BETWEEN 3 AND 4000)),
	CONSTRAINT "qc_reviews_checklist_array" CHECK (jsonb_typeof(checklist) = 'array')
);
--> statement-breakpoint
CREATE TABLE "design"."revision_files" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."revision_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"file_path" text NOT NULL,
	"file_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" bigint NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by" bigint,
	"removed_at" timestamp with time zone,
	CONSTRAINT "revision_files_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "revision_files_kind_check" CHECK (kind IN ('pdf','source','bom')),
	CONSTRAINT "revision_files_pdf_type" CHECK (kind <> 'pdf' OR file_type = 'pdf'),
	CONSTRAINT "revision_files_type_check" CHECK (file_type ~ '^[a-z0-9]{1,8}$'),
	CONSTRAINT "revision_files_size_check" CHECK (size_bytes > 0),
	CONSTRAINT "revision_files_removed_fields" CHECK ((removed_by IS NULL) = (removed_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "design"."transmittal_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."transmittal_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"transmittal_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	CONSTRAINT "transmittal_items_revision_id_unique" UNIQUE("revision_id")
);
--> statement-breakpoint
CREATE TABLE "design"."transmittals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "design"."transmittals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"job_id" bigint NOT NULL,
	"number" text NOT NULL,
	"purpose" text NOT NULL,
	"recipient" text NOT NULL,
	"note" text,
	"issued_by" bigint NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transmittals_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "transmittals_company_number_unique" UNIQUE("legal_entity_id","number"),
	CONSTRAINT "transmittals_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "transmittals_purpose_check" CHECK (purpose IN ('for_approval','for_construction','for_information')),
	CONSTRAINT "transmittals_text_lengths" CHECK (char_length(recipient) BETWEEN 2 AND 200 AND (note IS NULL OR char_length(note) <= 1000))
);
--> statement-breakpoint
ALTER TABLE "core"."customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."customers" ADD CONSTRAINT "customers_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."customers" ADD CONSTRAINT "customers_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."customers" ADD CONSTRAINT "customers_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."client_responses" ADD CONSTRAINT "client_responses_recorded_by_persons_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."client_responses" ADD CONSTRAINT "client_responses_revision_company_fk" FOREIGN KEY ("revision_id","legal_entity_id") REFERENCES "design"."drawing_revisions"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."counters" ADD CONSTRAINT "counters_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."design_jobs" ADD CONSTRAINT "design_jobs_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."design_jobs" ADD CONSTRAINT "design_jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "core"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."design_jobs" ADD CONSTRAINT "design_jobs_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."design_jobs" ADD CONSTRAINT "design_jobs_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."design_jobs" ADD CONSTRAINT "design_jobs_department_company_fk" FOREIGN KEY ("department_id","legal_entity_id") REFERENCES "hrms"."departments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."drawing_revisions" ADD CONSTRAINT "drawing_revisions_drawn_by_person_id_persons_id_fk" FOREIGN KEY ("drawn_by_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."drawing_revisions" ADD CONSTRAINT "drawing_revisions_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."drawing_revisions" ADD CONSTRAINT "drawing_revisions_submitted_by_persons_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."drawing_revisions" ADD CONSTRAINT "drawing_revisions_drawing_company_fk" FOREIGN KEY ("drawing_id","legal_entity_id") REFERENCES "design"."drawings"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."drawings" ADD CONSTRAINT "drawings_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."drawings" ADD CONSTRAINT "drawings_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."drawings" ADD CONSTRAINT "drawings_job_company_fk" FOREIGN KEY ("job_id","legal_entity_id") REFERENCES "design"."design_jobs"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."job_attachments" ADD CONSTRAINT "job_attachments_uploaded_by_persons_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."job_attachments" ADD CONSTRAINT "job_attachments_job_company_fk" FOREIGN KEY ("job_id","legal_entity_id") REFERENCES "design"."design_jobs"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."job_tickets" ADD CONSTRAINT "job_tickets_linked_by_persons_id_fk" FOREIGN KEY ("linked_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."job_tickets" ADD CONSTRAINT "job_tickets_job_company_fk" FOREIGN KEY ("job_id","legal_entity_id") REFERENCES "design"."design_jobs"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."job_tickets" ADD CONSTRAINT "job_tickets_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."qc_review_files" ADD CONSTRAINT "qc_review_files_review_company_fk" FOREIGN KEY ("review_id","legal_entity_id") REFERENCES "design"."qc_reviews"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."qc_reviews" ADD CONSTRAINT "qc_reviews_reviewer_person_id_persons_id_fk" FOREIGN KEY ("reviewer_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."qc_reviews" ADD CONSTRAINT "qc_reviews_revision_company_fk" FOREIGN KEY ("revision_id","legal_entity_id") REFERENCES "design"."drawing_revisions"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."revision_files" ADD CONSTRAINT "revision_files_uploaded_by_persons_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."revision_files" ADD CONSTRAINT "revision_files_removed_by_persons_id_fk" FOREIGN KEY ("removed_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."revision_files" ADD CONSTRAINT "revision_files_revision_company_fk" FOREIGN KEY ("revision_id","legal_entity_id") REFERENCES "design"."drawing_revisions"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."transmittal_items" ADD CONSTRAINT "transmittal_items_transmittal_company_fk" FOREIGN KEY ("transmittal_id","legal_entity_id") REFERENCES "design"."transmittals"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."transmittal_items" ADD CONSTRAINT "transmittal_items_revision_company_fk" FOREIGN KEY ("revision_id","legal_entity_id") REFERENCES "design"."drawing_revisions"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."transmittals" ADD CONSTRAINT "transmittals_issued_by_persons_id_fk" FOREIGN KEY ("issued_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design"."transmittals" ADD CONSTRAINT "transmittals_job_company_fk" FOREIGN KEY ("job_id","legal_entity_id") REFERENCES "design"."design_jobs"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_one_per_company" ON "core"."customers" USING btree ("legal_entity_id") WHERE legal_entity_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_design_jobs_company_status" ON "design"."design_jobs" USING btree ("legal_entity_id","status");--> statement-breakpoint
CREATE INDEX "idx_design_jobs_customer" ON "design"."design_jobs" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_revisions_one_open" ON "design"."drawing_revisions" USING btree ("drawing_id") WHERE status IN ('draft','submitted');--> statement-breakpoint
CREATE INDEX "idx_drawing_revisions_company_status" ON "design"."drawing_revisions" USING btree ("legal_entity_id","status");--> statement-breakpoint
CREATE INDEX "idx_job_attachments_job" ON "design"."job_attachments" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_job_tickets_job" ON "design"."job_tickets" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_qc_review_files_review" ON "design"."qc_review_files" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revision_files_one_pdf" ON "design"."revision_files" USING btree ("revision_id") WHERE kind = 'pdf' AND removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_revision_files_revision" ON "design"."revision_files" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "idx_transmittal_items_transmittal" ON "design"."transmittal_items" USING btree ("transmittal_id");--> statement-breakpoint
CREATE INDEX "idx_transmittals_job" ON "design"."transmittals" USING btree ("job_id");
--> statement-breakpoint
-- ---- written by hand (drizzle-kit does not generate these) ----
-- Nothing in design is deleted. Attachments, ticket links, QC decisions and their files, transmittals and client
-- responses are never changed either; jobs and drawings change (status, title) but are never deleted.
CREATE FUNCTION "design"."forbid_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DESIGN_APPEND_ONLY: % rows are never changed or deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE FUNCTION "design"."forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DESIGN_NO_DELETE: % rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_job_attachments_append_only" BEFORE UPDATE OR DELETE ON "design"."job_attachments" FOR EACH ROW EXECUTE FUNCTION "design"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_job_tickets_append_only" BEFORE UPDATE OR DELETE ON "design"."job_tickets" FOR EACH ROW EXECUTE FUNCTION "design"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_qc_reviews_append_only" BEFORE UPDATE OR DELETE ON "design"."qc_reviews" FOR EACH ROW EXECUTE FUNCTION "design"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_qc_review_files_append_only" BEFORE UPDATE OR DELETE ON "design"."qc_review_files" FOR EACH ROW EXECUTE FUNCTION "design"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_transmittals_append_only" BEFORE UPDATE OR DELETE ON "design"."transmittals" FOR EACH ROW EXECUTE FUNCTION "design"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_transmittal_items_append_only" BEFORE UPDATE OR DELETE ON "design"."transmittal_items" FOR EACH ROW EXECUTE FUNCTION "design"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_client_responses_append_only" BEFORE UPDATE OR DELETE ON "design"."client_responses" FOR EACH ROW EXECUTE FUNCTION "design"."forbid_change"();--> statement-breakpoint
CREATE TRIGGER "trg_design_jobs_no_delete" BEFORE DELETE ON "design"."design_jobs" FOR EACH ROW EXECUTE FUNCTION "design"."forbid_delete"();--> statement-breakpoint
CREATE TRIGGER "trg_drawings_no_delete" BEFORE DELETE ON "design"."drawings" FOR EACH ROW EXECUTE FUNCTION "design"."forbid_delete"();--> statement-breakpoint
-- A revision: never deleted, never moved to another drawing; once submitted its content never changes; its status only
-- moves forward (draft > submitted > qc_approved | changes_needed; qc_approved > issued | superseded; issued > accepted |
-- returned | superseded; accepted | returned > superseded).
CREATE FUNCTION "design"."guard_revision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DESIGN_NO_DELETE: drawing revisions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF ROW(NEW.tenant_id, NEW.public_id, NEW.legal_entity_id, NEW.drawing_id, NEW.seq, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.tenant_id, OLD.public_id, OLD.legal_entity_id, OLD.drawing_id, OLD.seq, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'DESIGN_REVISION_LOCKED: a revision stays on its drawing' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'drawing_revisions_identity_fixed';
  END IF;
  IF OLD.status <> 'draft' AND ROW(NEW.stage, NEW.code, NEW.title, NEW.change_note, NEW.client_project_reference, NEW.drawn_by_person_id,
       NEW.scale, NEW.sheet, NEW.updated_at, NEW.submitted_by, NEW.submitted_at)
     IS DISTINCT FROM ROW(OLD.stage, OLD.code, OLD.title, OLD.change_note, OLD.client_project_reference, OLD.drawn_by_person_id,
       OLD.scale, OLD.sheet, OLD.updated_at, OLD.submitted_by, OLD.submitted_at) THEN
    RAISE EXCEPTION 'DESIGN_REVISION_LOCKED: a submitted revision never changes' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'drawing_revisions_submitted_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'submitted')
    OR (OLD.status = 'submitted' AND NEW.status IN ('qc_approved', 'changes_needed'))
    OR (OLD.status = 'qc_approved' AND NEW.status IN ('issued', 'superseded'))
    OR (OLD.status = 'issued' AND NEW.status IN ('accepted', 'returned', 'superseded'))
    OR (OLD.status IN ('accepted', 'returned') AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'DESIGN_BAD_REVISION_STATUS: a revision does not go from % to %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_drawing_revisions_guard" BEFORE UPDATE OR DELETE ON "design"."drawing_revisions" FOR EACH ROW EXECUTE FUNCTION "design"."guard_revision"();--> statement-breakpoint
-- A revision file: added, and removed (once), only while its revision is a draft; never deleted or otherwise changed.
-- FOR SHARE waits for a submit that is running, so no file slips in beside it.
CREATE FUNCTION "design"."guard_revision_file"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rev_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DESIGN_NO_DELETE: revision files are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.removed_at IS NOT NULL OR ROW(NEW.tenant_id, NEW.public_id, NEW.legal_entity_id, NEW.revision_id, NEW.kind, NEW.name,
       NEW.file_path, NEW.file_type, NEW.size_bytes, NEW.uploaded_by, NEW.uploaded_at)
     IS DISTINCT FROM ROW(OLD.tenant_id, OLD.public_id, OLD.legal_entity_id, OLD.revision_id, OLD.kind, OLD.name,
       OLD.file_path, OLD.file_type, OLD.size_bytes, OLD.uploaded_by, OLD.uploaded_at)) THEN
    RAISE EXCEPTION 'DESIGN_FILE_FIXED: a revision file is only ever removed, once' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT status INTO rev_status FROM "design"."drawing_revisions" WHERE id = NEW.revision_id FOR SHARE;
  IF rev_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'DESIGN_REVISION_LOCKED: the files of a submitted revision never change' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'revision_files_draft_only';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_revision_files_guard" BEFORE INSERT OR UPDATE OR DELETE ON "design"."revision_files" FOR EACH ROW EXECUTE FUNCTION "design"."guard_revision_file"();--> statement-breakpoint
-- QC is independent: the reviewer never drew, created or submitted the revision, and is not (and never was) an assignee
-- of a ticket of the revision's design job.
CREATE FUNCTION "design"."check_qc_reviewer"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  SELECT rv.drawn_by_person_id, rv.created_by, rv.submitted_by, d.job_id INTO r
    FROM "design"."drawing_revisions" rv JOIN "design"."drawings" d ON d.id = rv.drawing_id WHERE rv.id = NEW.revision_id;
  IF NEW.reviewer_person_id = r.drawn_by_person_id OR NEW.reviewer_person_id = r.created_by OR NEW.reviewer_person_id = r.submitted_by THEN
    RAISE EXCEPTION 'DESIGN_QC_NOT_INDEPENDENT: the reviewer drew, created or submitted this revision'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'qc_reviews_reviewer_independent';
  END IF;
  IF EXISTS (SELECT 1 FROM "design"."job_tickets" jt
      JOIN "tickets"."ticket_assignees" a ON a.ticket_id = jt.ticket_id
      JOIN "hrms"."employments" e ON e.id = a.employment_id
     WHERE jt.job_id = r.job_id AND e.person_id = NEW.reviewer_person_id) THEN
    RAISE EXCEPTION 'DESIGN_QC_NOT_INDEPENDENT: the reviewer is assigned to a ticket of this design job'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'qc_reviews_reviewer_independent';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_qc_reviews_independent" BEFORE INSERT ON "design"."qc_reviews" FOR EACH ROW EXECUTE FUNCTION "design"."check_qc_reviewer"();--> statement-breakpoint
-- The companies of the group are customers (AE is the client of ATPL's design jobs). New databases: the seed adds them.
INSERT INTO "core"."customers" ("tenant_id", "code", "name", "legal_entity_id")
SELECT le."tenant_id", le."code", le."name", le."id" FROM "core"."legal_entities" le
 WHERE le."code" ~ '^[A-Z0-9][A-Z0-9-]{0,19}$' AND char_length(le."name") BETWEEN 2 AND 200
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Permissions. Design QC (new role) reviews; Admin user runs design jobs; the Designing head needs none (head of the
-- department in policy design.department_prefix).
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('core.customers.manage', 'core', 'Add customers to the Core customer list and change them (scope all)'),
  ('design.view', 'design', 'See the design jobs, drawings, transmittals and design reports (scope all: every company; otherwise the companies you work in)'),
  ('design.jobs.manage', 'design', 'Create and run design jobs: status, attachments, tickets, drawings, transmittals and client responses (Admin user)'),
  ('design.qc', 'design', 'Review submitted drawing revisions (Design QC): never a revision you drew, nor on a job whose tickets you are assigned to')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "core"."roles" ("tenant_id", "code", "name") SELECT t."id", 'design_qc', 'Design QC' FROM "core"."tenants" t
ON CONFLICT ("tenant_id", "code") DO NOTHING;--> statement-breakpoint
-- existing databases (new ones get the same from the seed)
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON
     (r."code" = 'design_qc' AND p."code" IN ('design.qc', 'design.view'))
  OR (r."code" = 'admin_user' AND p."code" IN ('design.jobs.manage', 'design.view', 'core.customers.manage'))
  OR (r."code" = 'system_admin' AND p."code" = 'core.customers.manage')
  OR (r."code" = 'management' AND p."code" IN ('design.view', 'core.customers.manage'))
ON CONFLICT DO NOTHING;
