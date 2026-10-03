import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Db } from "../src/db/client.js";
import { agents, newId, tenants, type Agent } from "../src/db/schema.js";
import { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";
import {
  GET_MESSAGES_TOOL,
  IMPORT_SESSION_TOOL,
  SEARCH_SESSIONS_TOOL,
  callSessionTool,
} from "../src/services/cloud-agent/session-tools.js";
import { ensureTestSpace } from "./helpers/spaces.js";

describe("Agent session search and history tools", () => {
  let root = "";
  let db: Db;
  let close: () => Promise<void>;
  let store: CloudAgentSessionStore;
  let tenantId = "";
  let agentA: Agent;
  let agentB: Agent;
  let currentSessionId = "";
  let archivedSessionId = "";
  let foreignSessionId = "";

  before(async () => {
    process.env.REDIS_URL = "off";
    root = mkdtempSync(join(tmpdir(), "zakura-session-tools-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const opened = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: root });
    db = opened.db;
    close = opened.close;
    tenantId = newId();
    await db.insert(tenants).values({ id: tenantId, slug: `tools-${tenantId}`, name: "Tools" });
    const spaceId = await ensureTestSpace(db, tenantId);
    const rows = await db.insert(agents).values([
      { id: newId(), tenantId, spaceId, name: "A", slug: "a", enableMemory: false, configJson: "{}" },
      { id: newId(), tenantId, spaceId, name: "B", slug: "b", enableMemory: false, configJson: "{}" },
    ]).returning();
    agentA = rows[0]!;
    agentB = rows[1]!;
    store = new CloudAgentSessionStore(db);
    currentSessionId = (await store.createSession({ tenantId, agentId: agentA.id, title: "Current" })).id;
    archivedSessionId = (await store.createSession({ tenantId, agentId: agentA.id, title: "Archived launch notes" })).id;
    foreignSessionId = (await store.createSession({ tenantId, agentId: agentB.id, title: "Archived launch foreign" })).id;
    for (const sessionId of [archivedSessionId, foreignSessionId]) {
      await store.appendEvent({
        sessionId,
        type: "user_message",
        runId: null,
        payload: { messageId: `user-${sessionId}`, content: "launch keyword and private detail" },
      });
      await store.appendEvent({
        sessionId,
        type: "assistant_message",
        runId: null,
        payload: { messageId: `assistant-${sessionId}`, content: "verified launch result" },
      });
    }
    await store.updateSession(tenantId, agentA.id, archivedSessionId, { status: "archived" });
    await store.updateSession(tenantId, agentB.id, foreignSessionId, { status: "archived" });
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("opts into archived search while preserving Agent ownership", async () => {
    const active = await callSessionTool(
      store, agentA, SEARCH_SESSIONS_TOOL, { query: "launch" }, currentSessionId,
    );
    assert.deepEqual(JSON.parse(active.text).results, []);
    const archived = await callSessionTool(
      store,
      agentA,
      SEARCH_SESSIONS_TOOL,
      { query: "launch", include_archived: true },
      currentSessionId,
    );
    const results = JSON.parse(archived.text).results as Array<{ session_id: string; snippet: string }>;
    assert.deepEqual(results.map((result) => result.session_id), [archivedSessionId]);
    assert.match(results[0]!.snippet, /launch/);
  });

  it("imports bounded history without mutating the current session", async () => {
    const before = await store.listEvents(currentSessionId, { limit: 100 });
    const imported = await callSessionTool(
      store,
      agentA,
      IMPORT_SESSION_TOOL,
      { session_id: archivedSessionId, max_chars: 2_000 },
      currentSessionId,
    );
    assert.notEqual(imported.isError, true, imported.text);
    assert.match(JSON.parse(imported.text).summary, /launch keyword|verified launch result/);
    assert.deepEqual(await store.listEvents(currentSessionId, { limit: 100 }), before);

    const foreign = await callSessionTool(
      store,
      agentA,
      GET_MESSAGES_TOOL,
      { session_id: foreignSessionId },
      currentSessionId,
    );
    assert.equal(foreign.isError, true);
    assert.match(foreign.text, /not owned/);
  });
});
