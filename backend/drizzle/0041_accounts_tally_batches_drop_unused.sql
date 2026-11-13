-- sent_at and response_xml were never written by any code (there is no connection to Tally). Stop instead of losing a value if one was.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "accounts"."tally_batches" WHERE "response_xml" IS NOT NULL OR "sent_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'ACCOUNTS_MIGRATION: tally_batches.sent_at / response_xml hold values; copy them somewhere safe before dropping the columns';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" DROP COLUMN "response_xml";--> statement-breakpoint
ALTER TABLE "accounts"."tally_batches" DROP COLUMN "sent_at";