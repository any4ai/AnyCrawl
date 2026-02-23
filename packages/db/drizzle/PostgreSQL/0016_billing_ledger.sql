CREATE TABLE "billing_ledger" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"api_key_id" uuid,
	"mode" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"charged" integer NOT NULL,
	"before_used" integer NOT NULL,
	"after_used" integer NOT NULL,
	"before_credits" integer,
	"after_credits" integer,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_ledger" ADD CONSTRAINT "billing_ledger_api_key_id_api_key_uuid_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("uuid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_ledger" ADD CONSTRAINT "billing_ledger_idempotency_key_unique" UNIQUE("idempotency_key");
--> statement-breakpoint
CREATE INDEX "billing_ledger_job_id_idx" ON "billing_ledger" USING btree ("job_id");
--> statement-breakpoint
CREATE INDEX "billing_ledger_api_key_id_idx" ON "billing_ledger" USING btree ("api_key_id");
--> statement-breakpoint
CREATE INDEX "billing_ledger_created_at_idx" ON "billing_ledger" USING btree ("created_at");
