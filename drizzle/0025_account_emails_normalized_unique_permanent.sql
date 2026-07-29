DO $$
DECLARE
  collision_groups integer;
BEGIN
  -- Fail closed on exact historical email_normalized duplicates without selecting
  -- a winner and without echoing email addresses into the exception text.
  SELECT COUNT(*)::integer INTO collision_groups
  FROM (
    SELECT 1
    FROM "town"."account_emails"
    GROUP BY "email_normalized"
    HAVING COUNT(*) > 1
  ) AS collisions;

  IF collision_groups > 0 THEN
    RAISE EXCEPTION 'account_emails exact normalized identity collision detected; refusing permanent uniqueness without historical repair';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "town"."account_emails_active_normalized_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "account_emails_normalized_unique" ON "town"."account_emails" USING btree ("email_normalized");
