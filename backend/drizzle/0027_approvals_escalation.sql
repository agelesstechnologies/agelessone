ALTER TABLE "hrms"."attendance_corrections" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD COLUMN "escalated_by" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD COLUMN "escalation_reason" text;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD COLUMN "escalated_by" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD COLUMN "escalation_reason" text;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "escalated_by" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD COLUMN "escalation_reason" text;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "escalated_by" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD COLUMN "escalation_reason" text;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_escalated_by_persons_id_fk" FOREIGN KEY ("escalated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_escalated_by_persons_id_fk" FOREIGN KEY ("escalated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_escalated_by_persons_id_fk" FOREIGN KEY ("escalated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_escalated_by_persons_id_fk" FOREIGN KEY ("escalated_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_escalation_fields" CHECK ((escalated_at IS NULL) = (escalation_reason IS NULL) AND (escalated_by IS NULL OR escalated_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "hrms"."overtime_requests" ADD CONSTRAINT "overtime_requests_escalation_fields" CHECK ((escalated_at IS NULL) = (escalation_reason IS NULL) AND (escalated_by IS NULL OR escalated_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "hrms"."expense_claims" ADD CONSTRAINT "expense_claims_escalation_fields" CHECK ((escalated_at IS NULL) = (escalation_reason IS NULL) AND (escalated_by IS NULL OR escalated_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "hrms"."leave_requests" ADD CONSTRAINT "leave_requests_escalation_fields" CHECK ((escalated_at IS NULL) = (escalation_reason IS NULL) AND (escalated_by IS NULL OR escalated_at IS NOT NULL));