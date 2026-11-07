-- The CEO does not apply for leave: the CEO role no longer holds hrms.leave.apply (existing databases; the seed matches).
-- The CEO still approves and reports leave (hrms.leave.approve, hrms.leave.report; Management sees everyone's).
DELETE FROM "core"."role_permissions" rp
 USING "core"."roles" r, "core"."permissions" p
 WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
   AND r."code" = 'ceo' AND p."code" = 'hrms.leave.apply';
