/**
 * Cloudflare API helpers for Named Tunnel management.
 *
 * Cloudflare Tunnel Write is NOT available via wrangler/dashboard OAuth scopes.
 * Operators must create an API Token with Account → Cloudflare Tunnel → Edit
 * (and optionally Zone → DNS → Edit).
 *
 * Docs: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/
 */

export type CloudflareApiCredentials = {
  apiToken: string;
  accountId: string;
  /** Optional: already-created tunnel */
  tunnelId?: string;
  tunnelName?: string;
  tunnelToken?: string;
};

export type CloudflareTunnelSummary = {
  id: string;
  name: string;
  status?: string;
  createdAt?: string;
};

const API = "https://api.cloudflare.com/client/v4";

export type CloudflareAdminClientOptions = {
  fetch?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
};

async function cfFetch<T>(
  apiToken: string,
  method: string,
  path: string,
  body?: unknown,
  opts: CloudflareAdminClientOptions = {},
): Promise<T> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const res = await fetchImpl(`${(opts.apiBase ?? API).replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const json = (await res.json()) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: T;
  };
  if (!res.ok || json.success === false) {
    const msg =
      json.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
      `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${method} ${path}: ${msg}`);
  }
  return json.result as T;
}

export class CloudflareAdminClient {
  constructor(
    private creds: CloudflareApiCredentials,
    private readonly opts: CloudflareAdminClientOptions = {},
  ) {}

  get credentials(): CloudflareApiCredentials {
    return this.creds;
  }

  /** Verify token + account by listing tunnels (empty list is OK). */
  async probe(): Promise<{ tunnelCount: number; accountId: string }> {
    const tunnels = await this.listTunnels();
    return { tunnelCount: tunnels.length, accountId: this.creds.accountId };
  }

  async listTunnels(): Promise<CloudflareTunnelSummary[]> {
    type Raw = Array<{
      id?: string;
      name?: string;
      status?: string;
      created_at?: string;
    }>;
    const result = await cfFetch<Raw>(
      this.creds.apiToken,
      "GET",
      `/accounts/${this.creds.accountId}/cfd_tunnel?is_deleted=false`,
      undefined,
      this.opts,
    );
    return (result ?? []).map((t) => ({
      id: String(t.id ?? ""),
      name: t.name ?? "",
      status: t.status,
      createdAt: t.created_at,
    }));
  }

  async createTunnel(name: string): Promise<{
    id: string;
    name: string;
    token: string;
  }> {
    type CreateResult = {
      id?: string;
      name?: string;
      token?: string;
    };
    const created = await cfFetch<CreateResult>(
      this.creds.apiToken,
      "POST",
      `/accounts/${this.creds.accountId}/cfd_tunnel`,
      { name, config_src: "cloudflare" },
      this.opts,
    );
    if (!created?.id) throw new Error("Cloudflare create tunnel returned no id");

    let token = created.token ?? "";
    if (!token) {
      token = await this.getTunnelToken(created.id);
    }
    return {
      id: created.id,
      name: created.name ?? name,
      token,
    };
  }

  async getTunnelToken(tunnelId: string): Promise<string> {
    // Token endpoint returns result as a string
    const token = await cfFetch<string>(
      this.creds.apiToken,
      "GET",
      `/accounts/${this.creds.accountId}/cfd_tunnel/${tunnelId}/token`,
      undefined,
      this.opts,
    );
    if (!token || typeof token !== "string") {
      throw new Error("Cloudflare tunnel token endpoint returned empty token");
    }
    return token;
  }
}
