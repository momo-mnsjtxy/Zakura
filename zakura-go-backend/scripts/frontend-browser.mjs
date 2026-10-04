import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const base = process.argv[2] ?? "http://127.0.0.1:3001";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const screenshots = "artifacts/go-backend-browser";
await mkdir(screenshots, { recursive: true });
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  const text = message.text();
  // The preserved account shell intentionally probes optional avatar/image
  // resources and lets their 404 responses fall back to generated initials.
  // Chromium reports those expected misses as console errors; HTTP 5xx and
  // actual JavaScript exceptions remain hard failures below.
  if (message.type() === "error" && !/Failed to load resource:.*404 \(Not Found\)/.test(text)) {
    errors.push(`console: ${text}`);
  }
});
page.on("response", (response) => {
  if (response.url().includes("/api/") && response.status() >= 400) {
    const pathname = new URL(response.url()).pathname;
    const expectedMissingAvatar = response.status() === 404 && /\/api\/users\/[^/]+\/avatar$/.test(pathname);
    if (!expectedMissingAvatar) errors.push(`${response.status()} ${pathname}`);
  }
});

try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForURL("**/setup");
  await page.locator("#email").fill("browser-admin@example.test");
  await page.locator("#password").fill("browser-contract-password");
  await page.locator("#adminName").fill("Browser Admin");
  await page.getByRole("button", { name: "开始使用" }).click();
  await page.waitForURL("**/onboarding");
  await page.getByText("开始使用", { exact: true }).waitFor();
  await page.getByText("稍后设置", { exact: true }).click();
  await page.waitForURL("**/dashboard/agents", { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  const body = await page.locator("body").innerText();
  if (!body.trim()) errors.push("agents dashboard rendered an empty document");
  if (body.includes("Application error") || body.includes("环境准备失败") || body.includes("无法连接 API")) {
    errors.push("frontend error boundary rendered");
  }
  await page.screenshot({ path: `${screenshots}/agents-dashboard.png`, fullPage: true });

  const verifyPage = async (path) => {
    const before = errors.length;
    const response = await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    if (!response?.ok()) errors.push(`${path} navigation returned ${response?.status() ?? "no response"}`);
    try {
      await page.waitForFunction(
        () => {
          const busy = document.querySelector('[role="progressbar"][aria-busy="true"]');
          const main = document.querySelector("main");
          return !busy && Boolean(main?.textContent?.trim());
        },
        undefined,
        { timeout: 15_000 },
      );
    } catch {
      errors.push(`${path} did not finish rendering meaningful content`);
    }
    const expectedPath = path === "/dashboard/mcp" ? "/dashboard/agents" : path;
    if (new URL(page.url()).pathname !== expectedPath) {
      errors.push(`${path} unexpectedly navigated to ${new URL(page.url()).pathname}`);
    }
    const text = await page.locator("body").innerText();
    if (!text.trim()) errors.push(`${path} rendered an empty document`);
    if (text.includes("Application error") || text.includes("环境准备失败") || text.includes("无法连接 API") || text.includes("加载失败") || text.includes("不存在或无权访问")) {
      errors.push(`${path} rendered the frontend error boundary`);
    }
    if (errors.length > before) throw new Error(errors.slice(before).join("\n"));
    const file = path.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    await page.screenshot({ path: `${screenshots}/${file}.png`, fullPage: true });
  };

  // Exercise the preserved frontend's highest-value platform/runtime callers,
  // rather than treating one successful dashboard navigation as compatibility.
  for (const path of [
    "/dashboard/settings/account",
    "/dashboard/settings/team",
    "/dashboard/settings/identity",
    "/dashboard/settings/usage",
    "/dashboard/settings/oauth-clients",
    "/dashboard/keys",
    "/dashboard/admin/users",
    "/dashboard/admin/tenants",
    "/dashboard/admin/runners",
    "/dashboard/admin/auth",
    "/dashboard/admin/platform",
    "/dashboard/admin/agent-defaults",
    "/dashboard/models",
    "/dashboard/mcp",
    "/dashboard/connections",
  ]) await verifyPage(path);

  const agent = await page.evaluate(async () => {
    const token = localStorage.getItem("zakura_session");
    const response = await fetch("/api/agents", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const rows = await response.json();
    return Array.isArray(rows) ? rows[0] ?? null : null;
  });
  if (!agent?.id) throw new Error("onboarding did not leave a browser-visible default agent");
  for (const path of [
    `/dashboard/agents/${encodeURIComponent(agent.id)}/overview`,
    `/dashboard/agents/${encodeURIComponent(agent.id)}/settings`,
    `/dashboard/agents/${encodeURIComponent(agent.id)}/memory`,
    `/dashboard/spaces/${encodeURIComponent(agent.spaceId)}/settings/gateway`,
  ]) await verifyPage(path);

  if (errors.length) throw new Error(errors.join("\n"));
  console.log("preserved frontend setup, onboarding, admin/settings, runtime, realtime and agent-detail flows passed");
} finally {
  await browser.close();
}
