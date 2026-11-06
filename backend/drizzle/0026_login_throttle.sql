CREATE TABLE "core"."login_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "login_throttle_failures_check" CHECK (failures >= 0)
);
--> statement-breakpoint
CREATE INDEX "idx_login_throttle_window" ON "core"."login_throttle" USING btree ("window_started_at");