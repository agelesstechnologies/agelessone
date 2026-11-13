CREATE TABLE "intercompany"."ic_statement_line_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intercompany"."ic_statement_line_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" bigint NOT NULL,
	"line_id" bigint NOT NULL,
	"legal_entity_id" bigint NOT NULL,
	"round" integer NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"amount_before_minor" bigint,
	"amount_after_minor" bigint,
	"by_person_id" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ic_statement_line_events_kind_check" CHECK (kind IN ('disputed','corrected','removed','explained','credited')),
	CONSTRAINT "ic_statement_line_events_reason_check" CHECK (char_length(trim(reason)) >= 3),
	CONSTRAINT "ic_statement_line_events_round_check" CHECK (round >= 1)
);
--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statement_line_events" ADD CONSTRAINT "ic_statement_line_events_by_person_id_persons_id_fk" FOREIGN KEY ("by_person_id") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany"."ic_statement_line_events" ADD CONSTRAINT "ic_statement_line_events_line_company_fk" FOREIGN KEY ("line_id","legal_entity_id") REFERENCES "intercompany"."ic_statement_lines"("id","legal_entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ic_statement_line_events_line" ON "intercompany"."ic_statement_line_events" USING btree ("line_id","id");--> statement-breakpoint
-- Written by hand: a line's dispute thread is append-only.
CREATE TRIGGER "trg_ic_statement_line_events_append_only" BEFORE UPDATE OR DELETE ON "intercompany"."ic_statement_line_events"
  FOR EACH ROW EXECUTE FUNCTION "intercompany"."forbid_change"();
