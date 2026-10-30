import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { apiDelete, apiGet, apiPatch, apiPost, gotoView, tid } from "./_helpers";

for (const width of [1440, 390]) {
  test(`Channels setup, recipient, nested routing and save/reopen at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await apiPatch(request, "/settings", { theme: "dark" });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    const project = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("channel-project"),
    });
    try {
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
      const condition = {
        all: [
          { field: "kind", op: "is", value: "message" },
          { field: "is_direct", op: "is", value: true },
          {
            any: [
              { field: "sender", op: "is", value: "456" },
              { not: { field: "text", op: "contains", value: "ignore" } },
            ],
          },
        ],
      };
      const builder = editor.getByTestId("channel-condition-builder");
      await expect(editor.getByRole("button", { name: "Advanced JSON" })).toHaveCount(0);
      await builder.getByRole("button", { name: "Add group", exact: true }).click();
      const group = builder.getByTestId("channel-condition-group").nth(1);
      await group.getByLabel("Condition field", { exact: true }).selectOption("sender");
      await group.getByLabel("Condition value", { exact: true }).fill("456");
      await group.getByRole("button", { name: "Add condition", exact: true }).click();
      const textCondition = group.getByTestId("channel-condition-row").nth(1);
      await textCondition.getByLabel("Condition comparison").selectOption("not:contains");
      await textCondition.getByLabel("Condition value").fill("ignore");
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
      await editor
        .locator("summary")
        .filter({ hasText: /^Custom commands/ })
        .click();
      await editor.getByRole("button", { name: "Add custom command", exact: true }).click();
      await editor.getByTestId("channel-command-name").fill("summary");
      await editor.getByTestId("channel-command-description").fill("Summarize a task");
      await editor.getByTestId("channel-command-prompt").fill("Summarize task $ARGUMENTS");
      await editor.getByTestId("channel-command-editor").scrollIntoViewIfNeeded();
      const commandBounds = await editor.getByTestId("channel-command-prompt").boundingBox();
      expect(
        commandBounds && commandBounds.x >= 0 && commandBounds.x + commandBounds.width <= width,
      ).toBe(true);
      await page.screenshot({ path: `../../.claude/docs/channels-command-${width}.png` });
      await editor.getByTestId("channel-command-apply").click();
      await editor
        .locator("summary")
        .filter({ hasText: /^Recipients/ })
        .click();
      await editor.getByTestId("channel-enable-replies-me").click();
      await editor.getByTestId("channel-replies-project").selectOption(project.id);
      await editor.getByTestId("channel-replies-agent").fill("default");
      await editor.getByTestId("channel-replies-model").fill("test-model");
      await editor.getByTestId("channel-replies-setup").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `../../.claude/docs/channels-replies-${width}.png` });
      await editor.getByTestId("channel-replies-apply").click();
      await editor.getByTestId("channel-save").click();
      await expect(page.getByRole("status").filter({ hasText: "Connection saved" })).toBeVisible();
      const twoWay = (
        await apiGet<
          Array<{
            id: string;
            config: { commands: unknown[] };
            targets: Array<{ inbound: boolean; outbound: boolean; attention: boolean }>;
            routes: unknown[];
          }>
        >(request, "/channels")
      ).find((c) => c.id === id);
      expect(twoWay?.config.commands).toEqual([
        {
          command: "summary",
          description: "Summarize a task",
          prompt: "Summarize task $ARGUMENTS",
        },
      ]);
      expect(twoWay?.targets[0]).toMatchObject({ inbound: true, outbound: true, attention: true });
      expect(twoWay?.routes).toHaveLength(2);
      expect(twoWay?.routes[1]).toMatchObject({
        action: { agent: "default", model: "test-model", project_id: project.id },
      });
      await page.reload();
      await settingsSection(page, "channels");
      await page.getByRole("button", { name: `Edit Telegram ${width}`, exact: true }).click();
      await editor
        .locator("summary")
        .filter({ hasText: /^Custom commands/ })
        .click();
      await expect(
        editor.getByRole("button", { name: "Edit /summary", exact: true }),
      ).toBeVisible();

      await expect(editor.getByText("Recipients (1)", { exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `../../.claude/docs/channels-${width}.png`, fullPage: true });
      await editor
        .locator("summary")
        .filter({ hasText: /^Inbound routing/ })
        .click();
      await expect(editor.getByTestId("channel-route-default")).toContainText(
        "Show setup guidance; no agent starts.",
      );
      await editor.getByRole("button", { name: "Set default", exact: true }).click();
      await expect(editor.getByTestId("channel-condition-builder")).toHaveCount(0);
      await editor.getByTestId("channel-route-apply").click();
      await editor.getByRole("button", { name: "Move Replies to Nir up", exact: true }).click();
      await expect(editor.getByTestId("channel-route-row").first()).toContainText("Replies to Nir");
      await expect(
        editor.getByRole("button", { name: "Move Private messages for Nir down", exact: true }),
      ).toBeDisabled();
      await editor.getByTestId("channel-save").click();
      await expect(page.getByRole("status").filter({ hasText: "Connection saved" })).toBeVisible();
      const ordered = (
        await apiGet<Array<{ id: string; routes: Array<{ name: string; condition: unknown }> }>>(
          request,
          "/channels",
        )
      ).find((c) => c.id === id);
      expect(ordered?.routes.map((route) => route.name)).toEqual([
        "Replies to Nir",
        "Private messages for Nir",
        "Otherwise",
      ]);
      expect(ordered?.routes[2]?.condition).toEqual({ always: true });
      await editor.getByRole("button", { name: "Move Replies to Nir down", exact: true }).click();
      await editor.getByTestId("channel-save").click();
      await expect(page.getByRole("status").filter({ hasText: "Connection saved" })).toBeVisible();
      await editor.getByTestId("channel-route-order").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `../../.claude/docs/channels-route-order-${width}.png` });
      await editor
        .getByRole("button", { name: "Edit rule Private messages for Nir", exact: true })
        .click();
      await expect(builder.getByLabel("Condition comparison").last()).toHaveValue("not:contains");
      await expect(builder.getByLabel("Group match").nth(1)).toHaveValue("any");
      const nested = builder.getByTestId("channel-condition-group").nth(1);
      const comparison = nested.getByLabel("Condition comparison").last();
      await comparison.focus();
      await comparison.selectOption("contains");
      await expect(comparison).toBeFocused();
      await comparison.selectOption("not:contains");
      const textValue = nested.getByLabel("Condition value").last();
      await textValue.fill("");
      await expect(editor.getByTestId("channel-route-apply")).toBeDisabled();
      await expect(builder).toBeVisible();
      await textValue.fill("ignore");
      await nested.getByLabel("Group match").selectOption("all");
      await nested.getByLabel("Exclude matches (NOT)").check();
      await editor.getByTestId("channel-route-apply").click();
      await editor.getByTestId("channel-save").click();
      await expect(page.getByRole("status").filter({ hasText: "Connection saved" })).toBeVisible();
      const negated = (
        await apiGet<Array<{ id: string; routes: Array<{ condition: unknown }> }>>(
          request,
          "/channels",
        )
      ).find((c) => c.id === id);
      expect(negated?.routes[0]?.condition).toEqual({
        all: [condition.all[0], condition.all[1], { not: { all: condition.all[2]?.any } }],
      });
      await page.reload();
      await settingsSection(page, "channels");
      await page.getByRole("button", { name: `Edit Telegram ${width}`, exact: true }).click();
      await editor
        .locator("summary")
        .filter({ hasText: /^Inbound routing/ })
        .click();
      await editor
        .getByRole("button", { name: "Edit rule Private messages for Nir", exact: true })
        .click();
      await expect(builder.getByLabel("Group match").nth(1)).toHaveValue("all");
      await expect(builder.getByLabel("Exclude matches (NOT)").nth(1)).toBeChecked();
      await builder.getByLabel("Exclude matches (NOT)").nth(1).uncheck();
      await builder.getByLabel("Group match").nth(1).selectOption("any");
      await builder.screenshot({ path: `../../.claude/docs/channels-conditions-${width}.png` });
      await editor.getByTestId("channel-condition-builder").scrollIntoViewIfNeeded();
      const ruleBounds = await editor.getByTestId("channel-condition-builder").boundingBox();
      expect(ruleBounds && ruleBounds.x >= 0 && ruleBounds.x + ruleBounds.width <= width).toBe(
        true,
      );
      await page.screenshot({
        path: `../../.claude/docs/channels-routing-${width}.png`,
        fullPage: false,
      });
      await page.getByTestId("theme-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
      await builder.screenshot({
        path: `../../.claude/docs/channels-conditions-light-${width}.png`,
      });
      await expect(builder.getByLabel("Group match").first()).toHaveValue("all");
      await page.getByTestId("theme-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
      expect(failures).toEqual([]);
    } finally {
      await apiDelete(request, `/projects/${project.id}`);
    }
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
  await page.screenshot({ path: "../../.claude/docs/channels-slack-setup.png" });
});
