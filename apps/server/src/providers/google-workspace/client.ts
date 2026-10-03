/** Google REST 调用封装 */
import { connectorJson, ConnectorHttpError } from "../connector-http.js";

export class GoogleApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(body.slice(0, 400) || `Google API HTTP ${status}`);
    this.name = "GoogleApiError";
    this.status = status;
    this.body = body;
  }
}

export async function googleFetch<T = unknown>(
  accessToken: string,
  url: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  try {
    return await connectorJson<T>(url, accessToken, {
      ...init,
      timeoutMs: 60_000,
      retry: { attempts: 3, baseDelayMs: 150, maxDelayMs: 2_000 },
    });
  } catch (error) {
    if (error instanceof ConnectorHttpError) {
      throw new GoogleApiError(error.status, error.responseBody);
    }
    throw error;
  }
}

export function headerValue(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

export function parseAddressList(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => {
      const m = s.match(/<([^>]+)>/);
      return (m?.[1] ?? s).trim();
    })
    .filter(Boolean);
}

export function toIsoDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function decodeBase64Url(data: string): string {
  const pad = data.length % 4 === 0 ? "" : "=".repeat(4 - (data.length % 4));
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString(
    "utf8",
  );
}

/** 将 Google REST 错误转为可操作提示 */
export function formatGoogleWorkspaceApiError(err: unknown): string {
  const raw =
    err instanceof GoogleApiError
      ? err.body || err.message
      : err instanceof Error
        ? err.message
        : String(err);
  if (/Chat app not found|hangouts-chat|configure the app in the Google Cloud console/i.test(raw)) {
    return (
      "Google Chat 应用未配置：请在同一 GCP 项目启用 Chat API，并打开 Configuration 填写 App name 后保存" +
      "（可关闭 Interactive features）。个人 Gmail 不可用，需 Workspace。" +
      " 链接：https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat"
    );
  }
  if (/does not have permission|PERMISSION_DENIED|caller does not have permission/i.test(raw)) {
    return (
      "Google API 权限不足。请确认 OAuth 同意屏幕已添加对应 scopes，且 GCP 项目已启用相关 API。" +
      ` 原始错误：${raw.slice(0, 200)}`
    );
  }
  return raw.slice(0, 400);
}
