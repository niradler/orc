import { expect, test } from "@playwright/test";
import { openChatActions, settingsSection } from "./_chat-ui";
import { API_BASE, API_SECRET, AUTH_HEADERS, apiPatch, gotoView, repoRoot } from "./_helpers";

for (const width of [1440, 390]) {
  test(`enabled coding agents drive the chat agent picker at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await apiPatch(request, "/settings", { agents: [] });
    const initial = await (
      await request.get(`${API_BASE}/settings/providers`, { headers: AUTH_HEADERS })
    ).json();
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
      await page.getByTestId("provider-new").click();
      await page.getByTestId("provider-new-name").fill("Qoder work");
      await page.getByTestId("provider-new-adapter").selectOption("other");
      await page.getByTestId("agent-custom").fill("qoder");
      await page.getByTestId("provider-create").click();
      await expect(
        page.getByRole("checkbox", { name: "Enable Qoder work", exact: true }),
      ).toBeChecked();
      await page.getByTestId("agent-settings-save").click();
      await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
      const section = page.getByRole("region", { name: /Coding providers/ });
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
      await expect(
        page.getByRole("menuitemradio", { name: "Qoder work", exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("chat-agent-option-copilot")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`chat-agent-picker-${width}.png`) });
      expect(errors).toEqual([]);
    } finally {
      const current = await (
        await request.get(`${API_BASE}/settings/providers`, { headers: AUTH_HEADERS })
      ).json();
      await request.put(`${API_BASE}/settings/providers`, {
        headers: AUTH_HEADERS,
        data: { ...initial, revision: current.revision },
      });
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
        await page.getByTestId("provider-select-codex").click();
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
        await page.getByText("Local account limits", { exact: true }).click();
        await page.getByRole("button", { name: "Check limits" }).click();
        await expect(page.getByTestId("provider-limits")).toContainText("100% used");
        await expect(page.getByTestId("provider-limits")).toContainText("Resets");
        let failSave = true;
        await page.route("**/api/settings/providers", (route) => {
          if (route.request().method() === "PUT" && failSave) {
            failSave = false;
            return route.fulfill({ status: 503, json: { error: "Temporary settings failure" } });
          }
          return route.continue();
        });
        await page.getByTestId("agent-settings-save").click();
        await expect(page.getByRole("alert")).toContainText("Temporary settings failure");
        await expect(page.getByTestId("provider-binary")).toHaveValue("C:\\Agent Tools\\codex.exe");
        await page.getByTestId("agent-settings-save").click();
        await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
        await page.reload();
        await expect(page.getByTestId("provider-binary")).toHaveValue("C:\\Agent Tools\\codex.exe");
        await expect(page.getByRole("button", { name: "Check limits" })).toBeHidden();
        await page.getByTestId("provider-use-default").click();
        await expect(page.getByTestId("provider-binary")).toHaveValue("");
        await expect(page.getByTestId("agent-settings-save")).toBeEnabled();
        await page.getByTestId("provider-discard").click();
        await expect(page.getByTestId("provider-binary")).toHaveValue("C:\\Agent Tools\\codex.exe");
        await expect(page.getByTestId("agent-settings-save")).toBeDisabled();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.getByTestId("provider-binary").focus();
        await expect(page.getByTestId("provider-binary")).toBeFocused();
        await page.getByTestId("provider-select-codex").focus();
        await page.screenshot({ path: testInfo.outputPath(`providers-${theme}-${width}.png`) });
      } finally {
        await apiPatch(request, "/settings", { provider_paths: {} });
      }
    });
  }
  test(`manual compaction uses an existing idle conversation and preserves drafts at ${width}px`, async ({
    page,
  }, testInfo) => {
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
    await page.getByTestId("chat-compact-button").hover();
    await page.screenshot({ path: testInfo.outputPath(`compaction-menu-${width}.png`) });
    const sent = page.waitForRequest(
      (request) => request.url().endsWith("/api/chat/stream") && request.method() === "POST",
    );
    await page.getByTestId("chat-compact-button").click();
    expect((await sent).postDataJSON().messages.at(-1).content).toBe("/compact");
    await expect(page.getByTestId("chat-input")).toHaveValue("Keep this draft");
  });
}

for (const width of [1440, 390])
  for (const theme of ["dark", "light"]) {
    test(`named provider creation, encrypted editing and defaults in ${theme} at ${width}px`, async ({
      page,
      request,
    }, testInfo) => {
      const initial = await (
        await request.get(`${API_BASE}/settings/providers`, { headers: AUTH_HEADERS })
      ).json();
      try {
        await apiPatch(request, "/settings", { theme });
        await page.addInitScript(
          (secret) =>
            localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
          API_SECRET,
        );
        await page.route("**/api/chat/models?**", (route) =>
          route.fulfill({ json: { models: [], warning: null } }),
        );
        await page.setViewportSize({ width, height: 1000 });
        await page.goto("/settings");
        await settingsSection(page, "agents");
        await page.getByTestId("provider-new").click();
        await page.getByTestId("provider-new-name").fill("Claude LiteLLM");
        await page.getByTestId("provider-new-adapter").selectOption("claude");
        await page.getByTestId("provider-create").click();
        await page.getByTestId("provider-model").fill("team-coding-model");
        const advanced = page.getByTestId("provider-advanced");
        await expect(advanced).not.toHaveAttribute("open", "");
        await advanced.locator("summary").click();
        for (const [name, value] of [
          ["ANTHROPIC_BASE_URL", "http://127.0.0.1:4000"],
          ["ANTHROPIC_AUTH_TOKEN", "demo-fixture-secret"],
        ]) {
          await page.getByTestId("provider-env-add").click();
          const row = page.getByTestId("provider-env-row").last();
          await row.getByTestId("provider-env-name").fill(name);
          await row.getByTestId("provider-env-value").fill(value);
        }
        await expect(page.getByTestId("provider-env-value").last()).toHaveAttribute(
          "type",
          "password",
        );
        await page.getByTestId("provider-options").fill('{"effort":"high","maxTurns":20}');
        await page.getByTestId("provider-default").selectOption({ label: "Claude LiteLLM" });
        await page.getByTestId("agent-settings-save").click();
        await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
        await page.reload();
        await settingsSection(page, "agents");
        await expect(page.getByTestId("provider-name")).toHaveValue("Claude LiteLLM");
        await page.getByTestId("provider-advanced").locator("summary").click();
        await expect(page.getByTestId("provider-env-value").last()).toHaveValue("");
        await expect(page.getByTestId("provider-env-value").last()).toHaveAttribute(
          "placeholder",
          /Saved secret/,
        );
        await page.getByTestId("provider-name").fill("Claude LiteLLM team");
        if (width === 1440 && theme === "dark") {
          const concurrent = await (
            await request.get(`${API_BASE}/settings/providers`, { headers: AUTH_HEADERS })
          ).json();
          expect(
            (
              await request.put(`${API_BASE}/settings/providers`, {
                headers: AUTH_HEADERS,
                data: {
                  ...concurrent,
                  providers: concurrent.providers.map((item: { id: string; name: string }) =>
                    item.id === "codex" ? { ...item, name: "Codex local" } : item,
                  ),
                },
              })
            ).ok(),
          ).toBe(true);
          await page.getByTestId("agent-settings-save").click();
          await expect(page.getByRole("alert")).toContainText("changed on the server");
          await expect(page.getByTestId("provider-name")).toHaveValue("Claude LiteLLM team");
          await page.getByRole("button", { name: "Discard draft and reload" }).click();
          await expect(page.getByTestId("provider-name")).toHaveValue("Claude LiteLLM");
          await page.getByTestId("provider-name").fill("Claude LiteLLM team");
        }
        await page.getByTestId("agent-settings-save").click();
        await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
        const saved = await (
          await request.get(`${API_BASE}/settings/providers`, { headers: AUTH_HEADERS })
        ).json();
        const profile = saved.providers.find(
          (item: { name: string }) => item.name === "Claude LiteLLM team",
        );
        expect(profile.environment[1].value).toBeNull();
        expect(JSON.stringify(saved)).not.toContain("demo-fixture-secret");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.setViewportSize({ width, height: 1000 });
        if (width === 390) await page.getByTestId("provider-advanced").locator("summary").click();
        await page.getByRole("heading", { name: "Settings", exact: true }).evaluate((element) => {
          for (let parent = element.parentElement; parent; parent = parent.parentElement)
            parent.scrollTop = 0;
        });
        if (theme === "dark" && process.env.ORC_CAPTURE_PROVIDER_SCREENS === "1")
          await page.screenshot({
            path:
              repoRoot() +
              `/docs/public/screens/settings-providers-${width === 1440 ? "desktop" : "phone"}.png`,
            fullPage: true,
          });
        else
          await page.screenshot({
            path: testInfo.outputPath(`providers-named-${width}.png`),
            fullPage: true,
          });
        await page.goto("/tasks?chat=full");
        await expect(
          page.getByTestId("chat-agent-model-button").filter({ visible: true }),
        ).toHaveAccessibleName(/Claude LiteLLM team, team-coding-model.*High effort/);
        const sent = page.waitForRequest(
          (req) => req.url().endsWith("/api/chat/stream") && req.method() === "POST",
        );
        await page.getByTestId("chat-input").fill("Reply with exactly: profile ready");
        await page.getByTestId("chat-input").press("Enter");
        expect((await sent).postDataJSON()).toMatchObject({
          providerId: profile.id,
          agent: "claude",
          model: "team-coding-model",
          agentOptions: { claude: { options: { effort: "high" } } },
        });
        await expect(page.getByTestId("chat-messages")).toContainText("profile ready");
        await page.getByTestId("chat-agent-model-button").filter({ visible: true }).click();
        await page.getByTestId("chat-agent-option-claude").click();
        await expect(
          page.getByTestId("chat-agent-model-button").filter({ visible: true }),
        ).toHaveAccessibleName("Agent and model: Claude Code, Agent default");
      } finally {
        const current = await (
          await request.get(`${API_BASE}/settings/providers`, { headers: AUTH_HEADERS })
        ).json();
        const restored = await request.put(`${API_BASE}/settings/providers`, {
          headers: AUTH_HEADERS,
          data: { ...initial, revision: current.revision },
        });
        expect(restored.ok()).toBe(true);
      }
    });
  }

test.describe("provider help", () => {
  test.use({ hasTouch: true });
  for (const width of [1440, 390])
    for (const theme of ["dark", "light"]) {
      test(`info help supports hover, focus, tap and dismissal in ${theme} at ${width}px`, async ({
        page,
        request,
      }) => {
        await apiPatch(request, "/settings", { theme });
        await page.addInitScript(
          (secret) =>
            localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
          API_SECRET,
        );
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/settings");
        await settingsSection(page, "agents");
        await page.getByTestId("provider-select-codex").click();
        const trigger = page.getByTestId("provider-binary-help");
        const content = page.getByTestId("provider-binary-help-content");
        await expect(content).toBeHidden();
        await trigger.hover();
        await expect(content).toBeVisible();
        await expect(content).toContainText("SSH uses its remote installation");
        await content.hover();
        await expect(content).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(content).toBeHidden();
        await page.getByTestId("provider-name").focus();
        await trigger.focus();
        await expect(content).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(content).toBeHidden();
        await trigger.press("Enter");
        await expect(content).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(content).toBeHidden();
        await trigger.tap();
        await expect(content).toBeVisible();
        const bounds = await content.boundingBox();
        expect(bounds?.x).toBeGreaterThanOrEqual(0);
        expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
        await page.getByTestId("provider-name").tap();
        await expect(content).toBeHidden();
        await page.getByTestId("provider-advanced").locator("summary").tap();
        await page.getByTestId("provider-env-help").tap();
        await expect(page.getByTestId("provider-env-help-content")).toContainText(
          "Empty values clear inherited values",
        );
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("agent-settings-save")).toBeDisabled();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      });
    }
});
