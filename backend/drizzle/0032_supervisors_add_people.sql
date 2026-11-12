-- Supervisors and department heads add people (scope team: any department of a company they have an active job in;
-- HR keeps scope all). Existing databases; the seed matches.
UPDATE "core"."permissions"
   SET "description" = 'Add people with their first job: scope all (HR) any company; otherwise (Supervisor) any department of a company you work in'
 WHERE "code" = 'hrms.people.create';--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" = 'hrms.people.create'
 WHERE r."code" = 'supervisor'
ON CONFLICT DO NOTHING;
