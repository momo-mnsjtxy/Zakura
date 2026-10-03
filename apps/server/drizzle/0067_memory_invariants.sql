-- Repair legacy rows deterministically before enforcing one default per tenant.
-- Prefer an existing default; otherwise promote the oldest provider.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY tenant_id
      ORDER BY is_default DESC, created_at ASC, id ASC
    ) AS desired_rank
  FROM memory_providers
)
UPDATE memory_providers AS provider
SET is_default = (ranked.desired_rank = 1)
FROM ranked
WHERE provider.id = ranked.id
  AND provider.is_default IS DISTINCT FROM (ranked.desired_rank = 1);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_providers_one_default"
  ON "memory_providers" ("tenant_id")
  WHERE "is_default" = true;
--> statement-breakpoint
-- Older schemas already constrain the raw memory-id pair. Keep the tenant/agent
-- ownership tuple explicit so idempotent inserts can target the complete domain key.
WITH duplicate_edges AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY tenant_id, agent_id, from_memory_id, to_memory_id, relation
      ORDER BY created_at ASC, id ASC
    ) AS duplicate_rank
  FROM memory_edges
)
DELETE FROM memory_edges AS edge
USING duplicate_edges
WHERE edge.id = duplicate_edges.id
  AND duplicate_edges.duplicate_rank > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_edges_tenant_agent_pair_rel"
  ON "memory_edges" ("tenant_id", "agent_id", "from_memory_id", "to_memory_id", "relation");
