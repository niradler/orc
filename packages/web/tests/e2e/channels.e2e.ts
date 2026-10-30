import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { apiGet, apiPost, gotoView, tid } from "./_helpers";

for (const width of [1440, 390]) {
  test(`Channels setup, recipient, nested routing and save/reopen at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    const project = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("channel-project"),
    });
    await gotoView(page, "settings");
    await settingsSection(page, "channels");
    await page.getByTestId("channel-add").click();
    const addBounds = await page.getByTestId("channel-add").boundingBox();
    expect(addBounds && addBounds.x + addBounds.width <= width).toBe(true);
    const id = tid("telegram");
    await page.getByTestId("channel-id").fill(id);
    await page.getByTestId("channel-name").fill(`Telegram ${width}`);
    await page.getByTestId("channel-credential-token").fill("private-test-credential");
    await page.getByTestId("channel-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Connection saved" })).toBeVisible();
    const editor = page.getByTestId("channel-editor").filter({ visible: true });
    await editor
      .locator("summary")
      .filter({ hasText: /^Recipients/ })
      .click();
    await editor.getByRole("button", { name: "Add recipient", exact: true }).click();
    await page.getByTestId("channel-target-name").fill("Nir");
    await page.getByTestId("channel-target-chat").fill("123");
    await page.getByTestId("channel-target-users").fill("456");
    await editor.getByLabel("Allow inbound", { exact: true }).check();
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: `Edit Telegram ${width}`, exact: true }).click();
    await expect(page.getByTestId("channel-target-chat").filter({ visible: true })).toHaveValue(
      "123",
    );
    await editor.getByTestId("channel-target-apply").click();
    await editor
      .locator("summary")
      .filter({ hasText: /^Inbound routing/ })
      .click();
    await editor.getByRole("button", { name: "Add routing rule", exact: true }).click();
    await editor.getByTestId("channel-route-name").fill("Private messages for Nir");
    await editor.getByTestId("channel-route-project").selectOption(project.id);
    await editor.getByRole("button", { name: "Advanced JSON", exact: true }).click();
    const condition = {
      all: [
        { field: "is_direct", op: "is", value: true },
        {
          any: [
            { field: "sender", op: "is", value: "456" },
            { not: { field: "text", op: "contains", value: "ignore" } },
          ],
        },
      ],
    };
    await editor.getByTestId("channel-condition-json").fill(JSON.stringify(condition));
    await editor.getByTestId("channel-route-apply").click();
    await editor.getByTestId("channel-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Connection saved" })).toBeVisible();
    await page.reload();
    await settingsSection(page, "channels");
    await page.getByRole("button", { name: `Edit Telegram ${width}`, exact: true }).click();
    await expect(
      page.getByTestId("channel-credential-token").filter({ visible: true }),
    ).toHaveValue("");
    const stored = (
      await apiGet<
        Array<{
          id: string;
          revision: number;
          targets: unknown[];
          routes: Array<{ condition: unknown }>;
        }>
      >(request, "/channels")
    ).find((c) => c.id === id);
    expect(stored?.revision).toBe(2);
    expect(stored?.targets).toHaveLength(1);
    expect(stored?.routes[0]?.condition).toEqual(condition);
    await expect(editor.getByText("Recipients (1)", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `../../.claude/docs/channels-${width}.png`, fullPage: true });
    await editor
      .locator("summary")
      .filter({ hasText: /^Inbound routing/ })
      .click();
    await editor.getByRole("button", { name: "Edit rule", exact: true }).click();
    await editor.getByTestId("channel-condition-json").scrollIntoViewIfNeeded();
    const ruleBounds = await editor.getByTestId("channel-condition-json").boundingBox();
    expect(ruleBounds && ruleBounds.x >= 0 && ruleBounds.x + ruleBounds.width <= width).toBe(true);
    await page.screenshot({
      path: `../../.claude/docs/channels-routing-${width}.png`,
      fullPage: true,
    });
    expect(failures).toEqual([]);
  });
}

test("Slack setup shows its own credentials and native onboarding", async ({ page }) => {
  await gotoView(page, "settings");
  await settingsSection(page, "channels");
  await page.getByRole("combobox", { name: "New channel provider" }).selectOption("slack");
  await page.getByTestId("channel-add").click();
  await expect(page.getByTestId("channel-credential-bot_token")).toBeVisible();
  await expect(page.getByTestId("channel-credential-app_token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy Slack app manifest" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pair my Telegram" })).toHaveCount(0);
});
