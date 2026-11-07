-- Who creates tickets: the head of the ticket's department, or a holder of tickets.create (Supervisor) for any department
-- of a company they work in. Management (CEO) and Admin user keep running tickets but no longer create them.
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('tickets.create', 'tickets', 'Create tickets for any department of a company you work in (Supervisor). Department heads create for their departments')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
UPDATE "core"."permissions"
   SET "description" = 'Run tickets (assign, edit, hold, cancel, approve): scope all (admin user, Management) every ticket; otherwise a department head for their departments. Creating needs tickets.create or being the department head'
 WHERE "code" = 'tickets.manage';--> statement-breakpoint
-- existing databases: the Supervisor role gets it (new databases get it from the seed)
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" = 'tickets.create'
 WHERE r."code" = 'supervisor'
ON CONFLICT DO NOTHING;
