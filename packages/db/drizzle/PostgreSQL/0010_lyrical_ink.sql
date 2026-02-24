DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'api_key' AND column_name = 'subscription_tier'
    ) THEN
        ALTER TABLE "api_key" ADD COLUMN "subscription_tier" text DEFAULT 'free' NOT NULL;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'jobs' AND column_name = 'deducted_at'
    ) THEN
        ALTER TABLE "jobs" ADD COLUMN "deducted_at" timestamp;
    END IF;
END $$;