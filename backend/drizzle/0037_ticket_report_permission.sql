-- The full report of one ticket as a PDF (everything in the ticket, photos included): a Manager / department head for the
-- tickets they manage (canManage: department head, created or supervises it), Management (scope all) for any ticket.
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('tickets.report', 'tickets', 'Download the full report of a ticket you manage (Manager, department head) or any ticket (Management)')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- existing databases: the Manager and Management roles get it (new databases get it from the seed too)
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" = 'tickets.report'
 WHERE r."code" IN ('manager', 'management')
ON CONFLICT DO NOTHING;
