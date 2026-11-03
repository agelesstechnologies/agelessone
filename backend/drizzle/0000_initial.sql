CREATE SCHEMA "core";
--> statement-breakpoint
CREATE SCHEMA "hrms";
--> statement-breakpoint
CREATE SCHEMA "tickets";
--> statement-breakpoint
CREATE TABLE "core"."persons" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."persons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"person_type" text NOT NULL,
	"display_name" text NOT NULL,
	"full_name" text NOT NULL,
	"mobile" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persons_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "hrms"."attendance_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."attendance_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"person_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"accuracy_m" integer,
	"location_status" text,
	CONSTRAINT "attendance_events_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "hrms"."work_days" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."work_days_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"person_id" bigint NOT NULL,
	"work_date" date NOT NULL,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"overtime_minutes" integer DEFAULT 0 NOT NULL,
	"day_status" text NOT NULL,
	"locked_for_payroll" boolean DEFAULT false NOT NULL,
	CONSTRAINT "work_days_person_id_work_date_unique" UNIQUE("person_id","work_date")
);
--> statement-breakpoint
CREATE TABLE "hrms"."expense_categories" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."expense_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"receipt_required" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hrms"."expense_claims" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."expense_claims_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"person_id" bigint NOT NULL,
	"category_id" bigint NOT NULL,
	"spent_on" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"ticket_id" bigint,
	"status" text DEFAULT 'submitted' NOT NULL,
	CONSTRAINT "expense_claims_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "hrms"."leave_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."leave_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"person_id" bigint NOT NULL,
	"leave_type_id" bigint NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"days" numeric(5, 1) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "leave_requests_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "hrms"."leave_types" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."leave_types_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"policy_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hrms"."employments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."employments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"person_id" bigint NOT NULL,
	"employee_code" text NOT NULL,
	"employment_type" text NOT NULL,
	"joined_on" date NOT NULL,
	"exit_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "employments_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "hrms"."certificates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."certificates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"person_id" bigint NOT NULL,
	"name" text NOT NULL,
	"expires_on" date,
	"status" text DEFAULT 'review' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hrms"."skills" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hrms"."skills_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets"."tickets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."tickets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"priority" smallint NOT NULL,
	"status" text DEFAULT 'assigned' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"created_by" bigint NOT NULL,
	CONSTRAINT "tickets_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
ALTER TABLE "hrms"."attendance_events" ADD CONSTRAINT "attendance_events_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."work_days" ADD CONSTRAINT "work_days_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "hrms"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "tickets"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "hrms"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD CONSTRAINT "employments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."certificates" ADD CONSTRAINT "certificates_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;