import { expect, test } from "@playwright/test";
import { openChatActions, settingsSection } from "./_chat-ui";
import { API_SECRET, apiPatch, gotoView } from "./_helpers";

for (const width of [1440, 390]) {
  test(`enabled coding agents drive the chat agent picker at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await apiPatch(request, "/settings", { agents: [] });
    await page.addInitScript(
      (secret) =>
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
      API_SECRET,
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings");
      await settingsSection(page, "agents");
      await expect(page.getByTestId("agent-enabled-copilot")).toBeChecked();
      await expect(page.getByTestId("agent-enabled-opencode")).not.toBeChecked();
      await expect(page.getByTestId("agent-settings-save")).toBeDisabled();
      await page.getByTestId("agent-enabled-copilot").uncheck();
      await page.getByTestId("agent-enabled-opencode").check();
      await page.getByTestId("agent-custom").fill("qoder");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByTestId("agent-enabled-qoder")).toBeChecked();
      await page.getByTestId("agent-settings-save").click();
      await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
      const section = page.getByRole("region", { name: "Coding agents" });
      expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await section.screenshot({ path: testInfo.outputPath(`agent-settings-${width}.png`) });

      await page.reload();
      await settingsSection(page, "agents");
      await expect(page.getByTestId("agent-enabled-opencode")).toBeChecked();
      await expect(page.getByTestId("agent-enabled-copilot")).not.toBeChecked();

      await gotoView(page, "tasks");
      await page.goto("/tasks?chat=full");
      await page.getByTestId("chat-agent-model-button").filter({ visible: true }).click();
      await expect(page.getByTestId("chat-agent-option-opencode")).toHaveText("OpenCode");
      await expect(page.getByTestId("chat-agent-option-qoder")).toHaveText("qoder");
      await expect(page.getByTestId("chat-agent-option-copilot")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`chat-agent-picker-${width}.png`) });
      expect(errors).toEqual([]);
    } finally {
      await apiPatch(request, "/settings", { agents: [] });
    }
  });
}

for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"]) {
    test(`provider editor preserves and saves paths and shows limits in ${theme} at ${width}px`, async ({
      page,
      request,
    }, testInfo) => {
      await apiPatch(request, "/settings", { provider_paths: {}, theme });
      await page.addInitScript(
        (secret) =>
          localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
        API_SECRET,
      );
      await page.route("**/api/usage/quotas", (route) =>
        route.fulfill({
          json: {
            accounts: [
              {
                provider: "codex",
                status: "available",
                checked_at: new Date().toISOString(),
                windows: [
                  {
                    label: "5-hour window",
                    used_percent: 100,
                    resets_at: new Date(Date.now() + 3600000).toISOString(),
                  },
                ],
              },
            ],
          },
        }),
      );
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/settings");
        await settingsSection(page, "agents");
        await expect(page.getByTestId("provider-binary")).toHaveValue("");
        await page.getByTestId("provider-binary").fill("C:\\Agent Tools\\codex.exe");
        await page.getByTestId("provider-select-claude").click();
        await page.getByTestId("provider-binary").fill("~/bin/claude");
        await settingsSection(page, "appearance");
        await settingsSection(page, "agents");
        await expect(page.getByTestId("provider-binary")).toHaveValue("~/bin/claude");
        await page.getByTestId("provider-select-codex").click();
        await expect(page.getByTestId("provider-binary")).toHaveValue("C:\\Agent Tools\\codex.exe");
        await expect(page.getByRole("button", { name: "Check limits" })).toBeHidden();
        await page.getByText("Account limits", { exact: true }).click();
        await page.getByRole("button", { name: "Check limits" }).click();
        await expect(page.getByTestId("provider-limits")).toContainText("100% used");
        await expect(page.getByTestId("provider-limits")).toContainText("Resets");
        await page.getByTestId("agent-settings-save").click();
        await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
        await page.reload();
        await expect(page.getByTestId("provider-binary")).toHaveValue("C:\\Agent Tools\\codex.exe");
        await expect(page.getByRole("button", { name: "Check limits" })).toBeHidden();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.getByTestId("provider-binary").focus();
        await expect(page.getByTestId("provider-binary")).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath(`providers-${theme}-${width}.png`) });
      } finally {
        await apiPatch(request, "/settings", { provider_paths: {} });
      }
    });
  }
  test(`manual compaction uses an existing idle conversation and preserves drafts at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (secret) =>
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
      API_SECRET,
    );
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.goto("/tasks?chat=full");
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await openChatActions(page);
    await expect(page.getByTestId("chat-compact-button")).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByTestId("chat-input").fill("Reply with exactly: compact ready");
    await page.getByTestId("chat-input").press("Enter");
    await expect(page.getByTestId("chat-messages")).toContainText("compact ready");
    await page.getByTestId("chat-input").fill("Keep this draft");
    await openChatActions(page);
    await expect(page.getByTestId("chat-compact-button")).toBeEnabled();
    const sent = page.waitForRequest(
      (request) => request.url().endsWith("/api/chat/stream") && request.method() === "POST",
    );
    await page.getByTestId("chat-compact-button").click();
    expect((await sent).postDataJSON().messages.at(-1).content).toBe("/compact");
    await expect(page.getByTestId("chat-input")).toHaveValue("Keep this draft");
  });
}
