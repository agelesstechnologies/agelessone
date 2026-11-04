CREATE TABLE "hrms"."overtime_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."overtime_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"person_id" bigint NOT NULL,
	"employment_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"work_date" date NOT NULL,
	"minutes" integer NOT NULL,
	"reason" text NOT NULL,
	"ticket_id" bigint,
	"status" text DEFAULT 'submitted' NOT NULL,
	"requested_by" bigint NOT NULL,
	"approver_person_id" bigint,
	"decided_by" bigint,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"cancelled_by" bigint,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "overtime_requests_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "overtime_requests_status_check" CHECK (status IN ('submitted','approved','rejected','cancelled')),
	CONSTRAINT "overtime_requests_minutes_check" CHECK (minutes BETWEEN 1 AND 1440),
	CONSTRAINT "overtime_requests_reason_length" CHECK (char_length(reason) >= 3),
	CONSTRAINT "overtime_requests_not_own_decision" CHECK (decided_by IS NULL OR (decided_by <> person_id AND decided_by <> requested_by)),
	CONSTRAINT "overtime_requests_not_own_approver" CHECK (approver_person_id IS NULL OR (approver_person_id <> person_id AND approver_person_id <> requested_by)),
	CONSTRAINT "overtime_requests_rejected_has_reason" CHECK (status <> 'rejected' OR decision_reason IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "hrms"."work_days" DROP CONSTRAINT "work_days_minutes_check";--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD COLUMN "extra_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD COLUMN "approved_overtime_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "hrms"."employments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "tickets"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_requested_by_persons_id_fk" FOREIGN KEY ("requested_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_approver_person_id_persons_id_fk" FOREIGN KEY ("approver_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_decided_by_persons_id_fk" FOREIGN KEY ("decided_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_cancelled_by_persons_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_overtime_employment_date" ON "hrms"."overtime_requests" USING btree ("employment_id","work_date");--> statement-breakpoint
CREATE INDEX "idx_overtime_approver" ON "hrms"."overtime_requests" USING btree ("approver_person_id","status");--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD CONSTRAINT "work_days_extra_check" CHECK (extra_minutes BETWEEN 0 AND worked_minutes AND approved_overtime_minutes BETWEEN 0 AND extra_minutes);--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD CONSTRAINT "work_days_minutes_check" CHECK (worked_minutes BETWEEN 0 AND 1440);--> statement-breakpoint
-- Extra time so far was stored as overtime: keep it as extra_minutes; nothing is approved overtime yet. Locked days get
-- the same copy (the value only moves column), so the locked-day trigger is paused for this one statement.
ALTER TABLE "hrms"."work_days" DISABLE TRIGGER "trg_locked_day";--> statement-breakpoint
UPDATE "hrms"."work_days" SET "extra_minutes" = "overtime_minutes";--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ENABLE TRIGGER "trg_locked_day";
