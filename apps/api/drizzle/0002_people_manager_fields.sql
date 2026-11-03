ALTER TABLE "hrms"."employments" ADD COLUMN "manager_person_id" bigint;--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD COLUMN "designation" text;--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD CONSTRAINT "employments_manager_person_id_persons_id_fk" FOREIGN KEY ("manager_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hrms"."employments" ADD CONSTRAINT "employments_manager_not_self" CHECK (manager_person_id <> person_id);