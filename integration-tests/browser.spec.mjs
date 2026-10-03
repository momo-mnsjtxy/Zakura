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
