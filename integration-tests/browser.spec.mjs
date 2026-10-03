import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

test.beforeAll(async () => {
  await mkdir("artifacts/e2e", { recursive: true });
});

test("login advances through the real UI against the local API fixture", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/login");
  await expect(page.getByLabel("邮箱")).toBeVisible();
  await page.getByLabel("邮箱").fill("agent@example.test");
  await page.getByRole("button", { name: "使用邮箱继续" }).click();
  await expect(page.getByRole("textbox", { name: "密码", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "更换方式" }).click();
  await expect(page.locator("input#email")).toHaveValue("agent@example.test");
  await page.screenshot({ path: "artifacts/e2e/login-navigation.png", fullPage: true });
});

test("legacy dashboard aliases preserve navigation", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/login");
  await page.getByLabel("邮箱").fill("reset@example.test");
  await page.getByRole("button", { name: "使用邮箱继续" }).click();
  await page.getByRole("link", { name: "重置密码" }).click();
  await expect(page).toHaveURL(/\/forgot-password\?email=reset%40example\.test/);
  await page.screenshot({ path: "artifacts/e2e/reset-navigation.png", fullPage: true });
});

test("fixture user authenticates and reaches the agent dashboard", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  // Production GET /api/agents and GET /api/spaces both return JSON arrays;
  // the empty arrays are the smallest schema-valid authenticated fixture.
  await page.route(/\/api\/(?:agents|spaces)(?:\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.goto("http://127.0.0.1:3001/login");
  await page.getByLabel("邮箱").fill("member@example.test");
  await page.getByRole("button", { name: "使用邮箱继续" }).click();
  await page.locator("input#password").fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/agents/);
  await expect(page.getByText("Fixture Team").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(pageErrors, pageErrors.map((error) => error.stack ?? error.message).join("\n")).toEqual([]);
  await expect(page.getByText("页面出错了")).toHaveCount(0);
  await expect(page.getByText("还没有 Agent")).toBeVisible();
  await page.screenshot({ path: "artifacts/e2e/agent-dashboard.png", fullPage: true });
});

test("restricted MFA enrollment retries setup and stores session only after recovery acknowledgement", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.route(/\/api\/(?:agents|spaces)(?:\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  await page.goto("http://127.0.0.1:3001/login");
  await page.getByLabel("邮箱").fill("enroll@example.test");
  await page.getByRole("button", { name: "使用邮箱继续" }).click();
  await page.locator("input#password").fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();

  await expect(page.getByRole("heading", { name: "保护你的账号" })).toBeVisible();
  await expect(page.getByText("Authenticator setup temporarily unavailable")).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zakura_session"))).toBeNull();
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("img", { name: "MFA 二维码" })).toBeVisible();
  await expect(page.getByText("JBSWY3DPEHPK3PXP")).toBeVisible();
  await page.getByLabel("验证码").fill("123456");
  await page.getByRole("button", { name: "启用并继续" }).click();

  await expect(page.getByText("RECOVERY-ONE")).toBeVisible();
  await expect(page.getByText("RECOVERY-TWO")).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zakura_session"))).toBeNull();
  await page.getByRole("button", { name: "我已保存，继续" }).click();
  await expect(page).toHaveURL(/\/dashboard\/agents/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zakura_session"))).toBe("fixture-enrollment-session");
  await expect(page.getByText("页面出错了")).toHaveCount(0);
  expect(pageErrors, pageErrors.map((error) => error.stack ?? error.message).join("\n")).toEqual([]);
  await page.screenshot({ path: "artifacts/e2e/mfa-enrollment-dashboard.png", fullPage: true });
});

test("generic OAuth callback completes MFA before storing its session", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.route(/\/api\/(?:agents|spaces)(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("http://127.0.0.1:3001/console/oauth/fixture-mfa/callback?code=fixture&state=fixture");
  await expect(page.getByRole("heading", { name: "需要二次验证" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zakura_session"))).toBeNull();
  await page.getByLabel("验证码").fill("123456");
  await page.getByRole("button", { name: "验证", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/agents/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zakura_session"))).toBe("fixture-oauth-session");
  await expect(page.getByText("页面出错了")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("tenant switch enrollment retries without replacing the current session prematurely", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.route(/\/api\/(?:agents|spaces)(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  // Seed only the initial authenticated document. addInitScript runs again on
  // navigation and would overwrite the newly issued tenant session.
  await page.goto("http://127.0.0.1:3001/login");
  await page.evaluate(() => localStorage.setItem("zakura_session", "fixture-session"));
  await page.goto("http://127.0.0.1:3001/dashboard/agents");
  await page.getByText("Fixture Team", { exact: true }).first().click();
  await page.getByRole("menuitem", { name: /Second Team/ }).click();
  await expect(page.getByRole("heading", { name: "保护你的账号" })).toBeVisible();
  await expect(page.getByText("Tenant enrollment temporarily unavailable")).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zakura_session"))).toBe("fixture-session");
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("TENANTSECRET123")).toBeVisible();
  await page.getByLabel("验证码").fill("654321");
  await page.getByRole("button", { name: "启用并继续" }).click();
  await expect(page).toHaveURL(/\/dashboard\/agents/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zakura_session"))).toBe("fixture-switched-session");
  await expect(page.getByText("页面出错了")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
