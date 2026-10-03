import { expect, test } from "@playwright/test";

test("login advances through the real UI against the local API fixture", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/login");
  await expect(page.getByLabel("邮箱")).toBeVisible();
  await page.getByLabel("邮箱").fill("agent@example.test");
  await page.getByRole("button", { name: "使用邮箱继续" }).click();
  await expect(page.getByRole("textbox", { name: "密码", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "更换方式" }).click();
  await expect(page.locator("input#email")).toHaveValue("agent@example.test");
});

test("legacy dashboard aliases preserve navigation", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/login");
  await page.getByLabel("邮箱").fill("reset@example.test");
  await page.getByRole("button", { name: "使用邮箱继续" }).click();
  await page.getByRole("link", { name: "重置密码" }).click();
  await expect(page).toHaveURL(/\/forgot-password\?email=reset%40example\.test/);
});
