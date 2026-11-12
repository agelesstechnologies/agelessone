-- Supervisors are on site only (0034): they add no people, create no logins and approve nothing; a Manager or a
-- department head leads the team. The description of hrms.people.create (0032) still named the Supervisor.
UPDATE "core"."permissions"
   SET "description" = 'Add people with their first job: scope all (HR) any company; scope team (Manager, department head) any department of a company you work in'
 WHERE "code" = 'hrms.people.create';--> statement-breakpoint
-- Make sure the Supervisor role holds none of: adding people, team logins, any approval (role_permissions is
-- configuration, not history; 0034 removed permissions from it the same way).
DELETE FROM "core"."role_permissions" rp
 USING "core"."roles" r, "core"."permissions" p
 WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id" AND r."code" = 'supervisor'
   AND (p."code" IN ('hrms.people.create', 'core.users.team') OR p."code" LIKE '%.approve');
