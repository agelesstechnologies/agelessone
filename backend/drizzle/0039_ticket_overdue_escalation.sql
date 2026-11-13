ALTER TABLE "tickets"."tickets" ADD COLUMN "overdue_for" date;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "overdue_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD COLUMN "overdue_escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets"."tickets" ADD CONSTRAINT "tickets_overdue_fields" CHECK ((overdue_for IS NULL) = (overdue_alerted_at IS NULL) AND (overdue_escalated_at IS NULL OR overdue_alerted_at IS NOT NULL));