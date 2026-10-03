import type { ProviderPlugin } from "@zakura/core";
import type { McpToolDef } from "@zakura/shared";
import type { AppConfig } from "../../config.js";
import { createOauthRestProvider, restJson } from "../oauth-rest.js";

type SlackProduct = "channels" | "messages" | "users";
const PRODUCTS: SlackProduct[] = ["channels", "messages", "users"];

export function slackBuiltinUrl(product: SlackProduct): string {
  return `zakura://slack/${product}`;
}

export function resolveSlackProduct(value: string): SlackProduct | null {
  const raw = value.trim().toLowerCase();
  if (PRODUCTS.includes(raw as SlackProduct)) return raw as SlackProduct;
  const matched = raw.match(/^zakura:\/\/slack\/(channels|messages|users)$/);
  return matched ? (matched[1] as SlackProduct) : null;
}

async function slackApi<T>(
  token: string,
  method: string,
  params?: Record<string, string | undefined>,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, value);
    }
  }
  const json = await restJson<T & { ok?: boolean; error?: string }>(url.toString(), token, {
    method: body ? "POST" : "GET",
    ...(body ? { json: body } : {}),
    headers: body ? { "Content-Type": "application/json; charset=utf-8" } : undefined,
    retry: { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 },
  });
  if (json.ok === false) {
    throw new Error(`Slack ${method}: ${json.error ?? "request_failed"}`);
  }
  return json;
}

const toolDefs: Record<SlackProduct, McpToolDef[]> = {
  channels: [
    { name: "list_channels", description: "List conversations the bot can see.", inputSchema: { type: "object", properties: { types: { type: "string" }, limit: { type: "integer" } } } },
    { name: "get_channel", description: "Get channel info by id.", inputSchema: { type: "object", required: ["channel"], properties: { channel: { type: "string" } } } },
  ],
  messages: [
    { name: "history", description: "Fetch recent channel messages.", inputSchema: { type: "object", required: ["channel"], properties: { channel: { type: "string" }, limit: { type: "integer" } } } },
    { name: "post_message", description: "Post a message to a channel.", inputSchema: { type: "object", required: ["channel", "text"], properties: { channel: { type: "string" }, text: { type: "string" }, thread_ts: { type: "string" } } } },
  ],
  users: [
    { name: "list_users", description: "List workspace users.", inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
    { name: "get_user", description: "Get a user by id.", inputSchema: { type: "object", required: ["user"], properties: { user: { type: "string" } } } },
  ],
};

async function callSlackTool(
  token: string,
  product: SlackProduct,
  name: string,
  args: Record<string, unknown>,
) {
  const limit = String(Math.min(Math.max(Number(args.limit) || 50, 1), 200));
  if (product === "channels") {
    if (name === "list_channels") {
      return slackApi(token, "conversations.list", {
        types: String(args.types ?? "public_channel,private_channel"),
        limit,
      });
    }
    if (name === "get_channel") {
      return slackApi(token, "conversations.info", { channel: String(args.channel) });
    }
  }
  if (product === "messages") {
    if (name === "history") {
      return slackApi(token, "conversations.history", {
        channel: String(args.channel),
        limit,
      });
    }
    if (name === "post_message") {
      return slackApi(token, "chat.postMessage", undefined, {
        channel: String(args.channel),
        text: String(args.text),
        thread_ts: args.thread_ts ? String(args.thread_ts) : undefined,
      });
    }
  }
  if (product === "users") {
    if (name === "list_users") return slackApi(token, "users.list", { limit });
    if (name === "get_user") return slackApi(token, "users.info", { user: String(args.user) });
  }
  throw new Error(`Unknown Slack tool: ${name}`);
}

const factory = createOauthRestProvider({
  id: "slack",
  name: "Slack",
  description: "平台直接调用 Slack Web API，提供频道、消息与用户工具。",
  products: PRODUCTS,
  toolDefs,
  callTool: (product, name, token, args) =>
    callSlackTool(token, product as SlackProduct, name, args),
  health: async (token) => {
    await slackApi(token, "auth.test");
  },
});

export function injectSlackRuntime(config: AppConfig, db: unknown): void {
  factory.injectRuntime(config, db);
}

export function createSlackProvider(): ProviderPlugin {
  return factory.createProvider();
}
