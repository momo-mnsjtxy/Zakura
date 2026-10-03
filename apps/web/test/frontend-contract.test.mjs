import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("chat keeps deep-link, cancellation, reconnection and retry contracts", () => {
  const chat = read("../src/components/chat/chat-app.tsx");
  const socket = read("../src/lib/socket.ts");
  const api = read("../src/lib/api.ts");
  const transport = read("../src/lib/api-transport.ts");

  for (const contract of [
    "syncChatUrl",
    "cancelCloudRun",
    "interruptWithQueuedMessage",
    "subscribeCloudEvents",
    "sessionRequestGateRef",
  ]) {
    assert.match(chat, new RegExp(contract));
  }
  assert.match(socket, /window\.addEventListener\("online", wake\)/);
  assert.match(socket, /SESSION_CHANGED_EVENT/);
  assert.match(socket, /rememberUpgrade: true/);
  assert.match(api, /requestJson/);
  assert.match(transport, /throw new ApiError/);
});

test("navigation retains back paths and all primary product areas", () => {
  const sidebar = read("../src/components/app-sidebar.tsx");
  for (const href of [
    "/chat",
    "/dashboard/agents",
    "/dashboard/spaces",
    "/dashboard/models",
    "/dashboard/runners",
    "/dashboard/settings/account",
  ]) {
    assert.ok(sidebar.includes(href), `missing primary navigation target ${href}`);
  }
  assert.match(sidebar, /ArrowLeft/);
});

test("the entry route exposes an in-place API retry without stale updates", () => {
  const entry = read("../src/app/page.tsx");
  assert.match(entry, /setRetryKey\(\(value\) => value \+ 1\)/);
  assert.match(entry, /if \(!active\) return/);
  assert.match(entry, /active = false/);
});
