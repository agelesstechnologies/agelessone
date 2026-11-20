-- Batch states change from built/sent/accepted/rejected to built/approved/imported/cancelled. Only 'built' could ever have been
-- written; stop instead of guessing if any other state exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "accounts"."tally_batches" WHERE "state" <> 'built') THEN
    RAISE EXCEPTION 'ACCOUNTS_MIGRATION: tally_batches has rows in an old state; map them by hand before changing the state check';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" DROP CONSTRAINT "tally_batches_state_check";--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD COLUMN "import_result" text;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD COLUMN "approved_by" bigint;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD COLUMN "downloaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD COLUMN "finished_by" bigint;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_approved_by_persons_id_fk" FOREIGN KEY ("approved_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_finished_by_persons_id_fk" FOREIGN KEY ("finished_by") REFERENCES "core"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_approval_check" CHECK ((approved_by IS NULL) = (approved_at IS NULL) AND (state NOT IN ('approved','imported') OR approved_by IS NOT NULL));--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_not_own_approval" CHECK (approved_by IS NULL OR approved_by <> created_by);--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_download_after_approval" CHECK (downloaded_at IS NULL OR approved_by IS NOT NULL);--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_finished_check" CHECK ((state IN ('imported','cancelled')) = (finished_at IS NOT NULL AND finished_by IS NOT NULL));--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" ADD CONSTRAINT "tally_batches_state_check" CHECK (state IN ('built','approved','imported','cancelled'));