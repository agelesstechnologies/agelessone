CREATE TABLE "core"."legal_entities" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."legal_entities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(12) NOT NULL,
	"name" text NOT NULL,
	"legal_form" text NOT NULL,
	"pan" varchar(10),
	CONSTRAINT "legal_entities_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "legal_entities_tenant_id_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "legal_entities_legal_form_check" CHECK ("core"."legal_entities"."legal_form" IN ('partnership','private_limited','llp','proprietorship','other'))
);
--> statement-breakpoint
CREATE TABLE "core"."tenants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "core"."tenants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
ALTER TABLE "core"."legal_entities" ADD CONSTRAINT "legal_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE no action ON UPDATE no action;