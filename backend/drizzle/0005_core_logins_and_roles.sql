CREATE TABLE "core"."permissions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."permissions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" varchar(80) NOT NULL,
	"module" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "permissions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "core"."role_assignments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."role_assignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"person_id" bigint NOT NULL,
	"role_id" bigint NOT NULL,
	"scope" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"ended_at" timestamp with time zone,
	"granted_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_assignments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "role_assignments_scope_check" CHECK (scope IN ('own','team','all')),
	CONSTRAINT "role_assignments_not_self" CHECK (granted_by <> person_id),
	CONSTRAINT "role_assignments_dates" CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
--> statement-breakpoint
CREATE TABLE "core"."role_permissions" (
	"role_id" bigint NOT NULL,
	"permission_id" bigint NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "core"."roles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"code" varchar(40) NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "roles_tenant_code_unique" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "core"."users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"person_id" bigint NOT NULL,
	"login_phone" text,
	"login_email" text,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "users_person_id_unique" UNIQUE("person_id"),
	CONSTRAINT "users_login_phone_unique" UNIQUE("login_phone"),
	CONSTRAINT "users_login_email_unique" UNIQUE("login_email"),
	CONSTRAINT "users_has_login" CHECK (login_phone IS NOT NULL OR login_email IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "core"."role_assignments" ADD CONSTRAINT "role_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_assignments" ADD CONSTRAINT "role_assignments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_assignments" ADD CONSTRAINT "role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_assignments" ADD CONSTRAINT "role_assignments_granted_by_persons_id_fk" FOREIGN KEY ("granted_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "core"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."users" ADD CONSTRAINT "users_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_role_assignments_person" ON "core"."role_assignments" USING btree ("person_id");--> statement-breakpoint
-- The permission list (same for every tenant). Roles and who holds them are data, set per tenant.
INSERT INTO "core"."permissions" ("code", "module", "description") VALUES
  ('hrms.people.view',        'hrms', 'View people, their contacts and jobs'),
  ('hrms.people.create',      'hrms', 'Create people with their first job'),
  ('hrms.people.update',      'hrms', 'Change a person''s display name and status'),
  ('hrms.contacts.manage',    'hrms', 'Add and end phone numbers and emails'),
  ('hrms.contacts.review',    'hrms', 'See everyone who shares a phone number or email'),
  ('hrms.employments.manage', 'hrms', 'Add jobs in other companies and exit jobs'),
  ('hrms.employments.update', 'hrms', 'Change manager, department, designation or primary job'),
  ('core.users.manage',       'core', 'Create logins, reset passwords, give and end roles');