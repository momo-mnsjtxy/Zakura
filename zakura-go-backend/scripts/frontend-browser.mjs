import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:3001";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("response", (response) => {
  if (response.url().includes("/api/") && response.status() >= 500) {
    errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
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
  if (!body.includes("Zakura")) errors.push("agents dashboard did not render Zakura content");
  if (body.includes("Application error") || body.includes("环境准备失败") || body.includes("无法连接 API")) {
    errors.push("frontend error boundary rendered");
  }

  const verifyPage = async (path) => {
    const before = errors.length;
    const response = await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    if (!response?.ok()) errors.push(`${path} navigation returned ${response?.status() ?? "no response"}`);
    await page.waitForTimeout(1200);
    const text = await page.locator("body").innerText();
    if (!text.trim()) errors.push(`${path} rendered an empty document`);
    if (text.includes("Application error") || text.includes("环境准备失败") || text.includes("无法连接 API")) {
      errors.push(`${path} rendered the frontend error boundary`);
    }
    if (errors.length > before) throw new Error(errors.slice(before).join("\n"));
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
