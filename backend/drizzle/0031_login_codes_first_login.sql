CREATE TABLE "core"."login_codes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."login_codes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_codes_purpose_check" CHECK (purpose IN ('first_login','reset')),
	CONSTRAINT "login_codes_attempts_check" CHECK (attempts BETWEEN 0 AND 5)
);
--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."login_codes" ADD CONSTRAINT "login_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."login_codes" ADD CONSTRAINT "login_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_login_codes_user" ON "core"."login_codes" USING btree ("user_id","created_at");--> statement-breakpoint
-- Supervisors and department heads create logins for their own team (an Employee login; System admin still for anyone).
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('core.users.team', 'core', 'Create a login (Employee role) for a person in your team: someone you manage or in a department you head')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "core"."roles" r JOIN "core"."permissions" p ON p."code" = 'core.users.team'
 WHERE r."code" = 'supervisor'
ON CONFLICT DO NOTHING;
