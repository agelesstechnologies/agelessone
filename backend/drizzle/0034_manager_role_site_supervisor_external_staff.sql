CREATE TABLE "tickets"."ticket_external_staff" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets"."ticket_external_staff_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"ticket_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"agency" text,
	"trade" text,
	"from_date" date NOT NULL,
	"to_date" date,
	"photo_path" text,
	"photo_type" text,
	"added_by" bigint NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_external_staff_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "ticket_external_staff_dates_check" CHECK (to_date IS NULL OR to_date >= from_date),
	CONSTRAINT "ticket_external_staff_name_check" CHECK (char_length(name) BETWEEN 2 AND 100),
	CONSTRAINT "ticket_external_staff_photo_check" CHECK ((photo_path IS NULL) = (photo_type IS NULL) AND (photo_type IS NULL OR photo_type IN ('jpg','png')))
);
--> statement-breakpoint
ALTER TABLE "tickets"."ticket_external_staff" ADD CONSTRAINT "ticket_external_staff_added_by_persons_id_fk" FOREIGN KEY ("added_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets"."ticket_external_staff" ADD CONSTRAINT "ticket_external_staff_ticket_company_fk" FOREIGN KEY ("ticket_id","legal_entity_id") REFERENCES "tickets"."tickets"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ticket_external_staff_ticket" ON "tickets"."ticket_external_staff" USING btree ("ticket_id");--> statement-breakpoint
-- Roles: a new Manager role gets everything the Supervisor role had (approvals, add people, logins, create and run
-- tickets). The Supervisor role becomes on-site only: their own self-service plus the site work of the tickets they
-- supervise (tickets.site). Existing supervisors keep the Supervisor role; give them Manager where they lead a team.
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('tickets.site', 'tickets', 'On-site supervisor: requirements, external staff, daily updates, files, hold, resume and complete of the tickets you supervise')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "core"."roles" ("tenant_id", "code", "name")
SELECT r."tenant_id", 'manager', 'Manager' FROM "core"."roles" r WHERE r."code" = 'supervisor'
ON CONFLICT ("tenant_id", "code") DO NOTHING;--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT m."id", rp."permission_id"
  FROM "core"."roles" s JOIN "core"."role_permissions" rp ON rp."role_id" = s."id"
  JOIN "core"."roles" m ON m."tenant_id" = s."tenant_id" AND m."code" = 'manager'
 WHERE s."code" = 'supervisor'
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "core"."role_permissions" rp
 USING "core"."roles" r, "core"."permissions" p
 WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id" AND r."code" = 'supervisor'
   AND p."code" NOT IN ('hrms.people.view', 'hrms.expenses.submit', 'hrms.attendance.punch', 'hrms.leave.apply', 'hrms.skills.add',
                        'hrms.skills.view', 'payroll.payslip.own', 'tickets.types.view', 'tickets.view', 'tickets.work');--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" = 'tickets.site'
 WHERE r."code" = 'supervisor'
ON CONFLICT DO NOTHING;
