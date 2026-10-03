-- Durable tenant cleanup/outbox. Deliberately no FK to tenants: delete
-- tombstones must survive ownership-row removal long enough for every replica
-- to observe the teardown and for operators to inspect terminal failures.
CREATE TABLE IF NOT EXISTS "tenant_content_cleanup_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "idempotency_key" text NOT NULL,
  "tenant_id" text NOT NULL,
  "action" text NOT NULL,
  "payload_json" text DEFAULT '{}' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 8 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "locked_at" timestamp with time zone,
  "locked_by" text,
  "last_error" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_content_cleanup_jobs_idempotency"
  ON "tenant_content_cleanup_jobs" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_content_cleanup_jobs_ready"
  ON "tenant_content_cleanup_jobs" USING btree ("status", "available_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_content_cleanup_jobs_tenant"
  ON "tenant_content_cleanup_jobs" USING btree ("tenant_id", "created_at");
