CREATE TABLE "tickets"."ticket_time_split_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_time_split_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"before_minutes" integer NOT NULL,
	"suggested_minutes" integer NOT NULL,
	"approved_minutes" integer,
	CONSTRAINT "ticket_time_split_lines_request_ticket_unique" UNIQUE("request_id","ticket_id"),
	CONSTRAINT "ticket_time_split_lines_minutes_check" CHECK (before_minutes >= 0 AND suggested_minutes >= 0 AND (approved_minutes IS NULL OR approved_minutes >= 0))
);
--> statement-breakpoint
CREATE TABLE "tickets"."ticket_time_split_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_time_split_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"person_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"work_date" date NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" bigint,
	"decided_as" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"adjustment_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_time_split_requests_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ticket_time_split_requests_id_company_unique" UNIQUE("id","legal_entity_id"),
	CONSTRAINT "ticket_time_split_requests_status_check" CHECK (status IN ('pending','approved','rejected','cancelled')),
	CONSTRAINT "ticket_time_split_requests_decided" CHECK ((status IN ('approved','rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_as IS NOT NULL)),
	CONSTRAINT "ticket_time_split_requests_as_check" CHECK (decided_as IS NULL OR decided_as IN ('head','management')),
	CONSTRAINT "ticket_time_split_requests_not_own" CHECK (decided_by IS NULL OR decided_by <> person_id),
	CONSTRAINT "ticket_time_split_requests_rejected_reason" CHECK (status <> 'rejected' OR length(trim(coalesce(decision_reason, ''))) >= 3)
);
--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_split_lines" ADD CONSTRAINT "ticket_time_split_lines_request_company_fk" FOREIGN KEY ("request_id","legal_entity_id") REFERENCES "tickets"."ticket_time_split_requests"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_split_lines" ADD CONSTRAINT "ticket_time_split_lines_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_split_lines" ADD CONSTRAINT "ticket_time_split_lines_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_split_requests" ADD CONSTRAINT "ticket_time_split_requests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_split_requests" ADD CONSTRAINT "ticket_time_split_requests_decided_by_persons_id_fk" FOREIGN KEY ("decided_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_time_split_requests" ADD CONSTRAINT "ticket_time_split_requests_employment_company_fk" FOREIGN KEY ("employment_id","legal_entity_id") REFERENCES "hrms"."employments"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_time_split_requests_one_pending" ON "tickets"."ticket_time_split_requests" USING btree ("employment_id","work_date") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_ticket_time_split_requests_person_date" ON "tickets"."ticket_time_split_requests" USING btree ("person_id","work_date");