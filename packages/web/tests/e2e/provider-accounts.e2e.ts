import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { openChatAgentModel, settingsSection, showPickerTab } from "./_chat-ui";
import { API_BASE, API_SECRET, AUTH_HEADERS, apiGet } from "./_helpers";

type Profile = {
  id: string;
  name: string;
  agent: string;
  enabled: boolean;
  executable: string;
  home?: string;
  model: string;
  environment: { name: string; value: string | null; secret: boolean }[];
};
type Settings = { providers: Profile[]; default_provider_id: string; revision: string };

// The shard home is owned by run-e2e; fixtures live inside it and are removed in finally.
const home = homedir();
const fixtureRoot = join(home, "orc-account-fixtures");

async function restoreProviders(request: APIRequestContext, initial: Settings) {
  const current = await apiGet<Settings>(request, "/settings/providers");
  const restored = await request.put(`${API_BASE}/settings/providers`, {
    headers: AUTH_HEADERS,
    data: { ...initial, revision: current.revision },
  });
  expect(restored.ok()).toBe(true);
}

function secretInit() {
  return (secret: string) =>
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
}

for (const width of [1440, 390]) {
  test(`separate account creation, identity and sign-in command at ${width}px`, async ({
    page,
    request,
    context,
  }, testInfo) => {
    const initial = await apiGet<Settings>(request, "/settings/providers");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.addInitScript(secretInit(), API_SECRET);
      await page.route("**/api/chat/models?**", (route) =>
        route.fulfill({ json: { models: [], warning: null } }),
      );
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/settings");
      await settingsSection(page, "agents");
      await page.getByTestId("provider-new").click();
      await page.getByTestId("provider-new-name").fill("Claude Work");
      await page.getByTestId("provider-new-adapter").selectOption("claude");
      await page.getByTestId("provider-new-separate").check();
      await expect(page.getByText(/Sessions and login live in/)).toContainText(
        "~/.orc/agents/claude/claude-work",
      );
      await page.getByTestId("provider-create").click();
      await expect(page.getByTestId("provider-home")).toHaveValue(
        "~/.orc/agents/claude/claude-work",
      );
      await page.getByTestId("agent-settings-save").click();
      await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
      await expect(page.getByTestId("provider-account")).toContainText(
        "Not signed in in this directory",
      );
      const accountHome = join(home, ".orc", "agents", "claude", "claude-work");
      const command = page.getByTestId("provider-sign-in-copy").locator("..").locator("code");
      await expect(command).toContainText("CLAUDE_CONFIG_DIR");
      await expect(command).toContainText(accountHome);
      await page.getByTestId("provider-sign-in-copy").click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        await command.innerText(),
      );
      // Back to the shared login and forth again; the suggestion returns. The
      // identity panel describes the saved provider, so save before asserting it.
      await page.getByTestId("provider-home-toggle").click();
      await expect(page.getByTestId("provider-home")).toHaveValue("");
      await page.getByTestId("agent-settings-save").click();
      await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
      await expect(page.getByTestId("provider-sign-in-copy")).toHaveCount(0);
      await page.getByTestId("provider-home-toggle").click();
      await expect(page.getByTestId("provider-home")).toHaveValue(
        "~/.orc/agents/claude/claude-work",
      );
      await page.getByTestId("agent-settings-save").click();
      await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
      await expect(command).toContainText(accountHome);
      // One-click default saves without the full form.
      await page.getByTestId("provider-use-for-new").click();
      await expect(page.getByTestId("provider-use-for-new")).toHaveText("Used for new sessions");
      const saved = await apiGet<Settings>(request, "/settings/providers");
      const profile = saved.providers.find((item) => item.name === "Claude Work");
      expect(profile).toBeTruthy();
      expect(saved.default_provider_id).toBe(profile?.id);
      expect(profile?.home).toBe("~/.orc/agents/claude/claude-work");
      await page.reload();
      await settingsSection(page, "agents");
      await page.getByTestId(`provider-select-${profile?.id}`).click();
      await expect(page.getByTestId("provider-home")).toHaveValue(
        "~/.orc/agents/claude/claude-work",
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`provider-accounts-${width}.png`) });
    } finally {
      await restoreProviders(request, initial);
    }
  });
}

for (const width of [1440, 390]) {
  test(`delete a provider and reassign the default at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    const initial = await apiGet<Settings>(request, "/settings/providers");
    try {
      const withExtra: Settings = {
        ...initial,
        default_provider_id: "claude-delete-me",
        providers: [
          ...initial.providers,
          {
            id: "claude-delete-me",
            name: "Claude Delete Me",
            agent: "claude",
            enabled: true,
            executable: "",
            model: "",
            environment: [
              { name: "ANTHROPIC_AUTH_TOKEN", value: "fixture-delete-secret", secret: true },
            ],
          },
        ],
      };
      const saved = await request.put(`${API_BASE}/settings/providers`, {
        headers: AUTH_HEADERS,
        data: withExtra,
      });
      expect(saved.ok()).toBe(true);
      await page.addInitScript(secretInit(), API_SECRET);
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/settings");
      await settingsSection(page, "agents");
      await page.getByTestId("provider-select-claude-delete-me").click();
      await page.getByTestId("provider-delete").click();
      await expect(page.getByTestId("confirm-dialog-confirm")).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`provider-delete-confirm-${width}.png`),
      });
      // Cancel keeps the provider and its draft state.
      await page.getByTestId("confirm-dialog-cancel").click();
      await expect(page.getByTestId("provider-select-claude-delete-me")).toBeVisible();
      await page.getByTestId("provider-delete").click();
      await page.getByTestId("confirm-dialog-confirm").click();
      await expect(page.getByTestId("provider-select-claude-delete-me")).toHaveCount(0);
      await page.getByTestId("agent-settings-save").click();
      await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
      const after = await apiGet<Settings>(request, "/settings/providers");
      expect(after.providers.some((item) => item.id === "claude-delete-me")).toBe(false);
      expect(after.default_provider_id).not.toBe("claude-delete-me");
      expect(
        after.providers.some((item) => item.id === after.default_provider_id && item.enabled),
      ).toBe(true);
      expect(JSON.stringify(after)).not.toContain("fixture-delete-secret");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`provider-delete-${width}.png`) });
    } finally {
      await restoreProviders(request, initial);
    }
  });
}

test("delete is disabled for the last provider", async ({ page, request }) => {
  const initial = await apiGet<Settings>(request, "/settings/providers");
  try {
    const first = initial.providers[0];
    const single: Settings = {
      ...initial,
      providers: [first],
      default_provider_id: first.id,
    };
    const saved = await request.put(`${API_BASE}/settings/providers`, {
      headers: AUTH_HEADERS,
      data: single,
    });
    expect(saved.ok()).toBe(true);
    await page.addInitScript(secretInit(), API_SECRET);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/settings");
    await settingsSection(page, "agents");
    await expect(page.getByTestId("provider-delete")).toBeDisabled();
  } finally {
    await restoreProviders(request, initial);
  }
});

test("duplicate logins are flagged without exposing credentials", async ({ page, request }) => {
  const initial = await apiGet<Settings>(request, "/settings/providers");
  const accountHome = join(fixtureRoot, "dup");
  try {
    mkdirSync(accountHome, { recursive: true });
    writeFileSync(
      join(accountHome, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "dup@example.com", organizationName: "Acme" },
      }),
    );
    writeFileSync(
      join(accountHome, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "private-fixture-token", subscriptionType: "max" },
      }),
    );
    const withDuplicates: Settings = {
      ...initial,
      providers: [
        ...initial.providers,
        {
          id: "claude-dup-a",
          name: "Claude Dup A",
          agent: "claude",
          enabled: true,
          executable: "",
          home: accountHome,
          model: "",
          environment: [],
        },
        {
          id: "claude-dup-b",
          name: "Claude Dup B",
          agent: "claude",
          enabled: true,
          executable: "",
          home: accountHome,
          model: "",
          environment: [],
        },
      ],
    };
    const saved = await request.put(`${API_BASE}/settings/providers`, {
      headers: AUTH_HEADERS,
      data: withDuplicates,
    });
    expect(saved.ok()).toBe(true);
    await page.addInitScript(secretInit(), API_SECRET);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/settings");
    await settingsSection(page, "agents");
    await expect(page.getByTestId("provider-account-duplicate")).toContainText(
      "Claude Dup B uses the same login as Claude Dup A",
    );
    await page.getByTestId("provider-select-claude-dup-b").click();
    await expect(page.getByTestId("provider-account")).toContainText(
      "dup@example.com · max · Acme",
    );
    await expect(page.getByRole("alert").filter({ hasText: /^Same login as/ })).toContainText(
      "Same login as Claude Dup A.",
    );
    expect(await page.locator("body").innerText()).not.toContain("private-fixture-token");
  } finally {
    await restoreProviders(request, initial);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

for (const width of [1440, 390]) {
  test(`chat switches accounts in place and blocks switches while streaming at ${width}px`, async ({
    page,
    request,
  }) => {
    const initial = await apiGet<Settings>(request, "/settings/providers");
    const accountHome = join(fixtureRoot, "claude-two");
    try {
      const withSecond: Settings = {
        ...initial,
        default_provider_id: "claude",
        providers: [
          ...initial.providers.map((profile) =>
            profile.id === "claude" ? { ...profile, enabled: true } : profile,
          ),
          {
            id: "claude-two",
            name: "Claude Two",
            agent: "claude",
            enabled: true,
            executable: "",
            home: accountHome,
            model: "",
            environment: [],
          },
        ],
      };
      const saved = await request.put(`${API_BASE}/settings/providers`, {
        headers: AUTH_HEADERS,
        data: withSecond,
      });
      expect(saved.ok()).toBe(true);
      await page.addInitScript(secretInit(), API_SECRET);
      await page.route("**/api/chat/models?**", (route) =>
        route.fulfill({ json: { models: [], warning: null } }),
      );
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/tasks?chat=full");
      await expect(page.getByTestId("chat-input")).toBeEnabled();

      await page.getByTestId("chat-input").fill("Reply with exactly: FIRST.");
      await page.getByTestId("chat-input").press("Enter");
      // The app names the open conversation in the URL once the turn starts.
      await expect(page).toHaveURL(/chatThread=/);
      const threadId = new URL(page.url()).searchParams.get("chatThread") ?? "";
      expect(threadId).toBeTruthy();
      await expect(page.getByTestId("chat-messages")).toContainText("FIRST");

      await openChatAgentModel(page);
      await showPickerTab(page, "agent");
      await page.getByTestId("chat-provider-option-claude-two").click();
      await expect(
        page.getByTestId("chat-agent-model-button").filter({ visible: true }),
      ).toHaveAccessibleName(/Claude Two/);
      await page.keyboard.press("Escape");

      const secondSend = page.waitForRequest(
        (req) => req.url().endsWith("/api/chat/stream") && req.method() === "POST",
      );
      await page.getByTestId("chat-input").fill("Reply with exactly: SECOND.");
      await page.getByTestId("chat-input").press("Enter");
      const payload = (await secondSend).postDataJSON() as {
        threadId?: string;
        providerId?: string;
      };
      expect(payload.threadId).toBe(threadId);
      expect(payload.providerId).toBe("claude-two");
      await expect(page.getByTestId("chat-messages")).toContainText("SECOND");
      await expect(page.getByTestId("chat-messages")).toContainText("FIRST");

      // While a response streams, other accounts of the same agent stay locked.
      // Wait for the previous turn to settle first: a send during streaming is
      // queued (#330), so it would not reach the thread before the assertion.
      await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
      await page.getByTestId("chat-input").fill("reply after 3000ms");
      await page.getByTestId("chat-input").press("Enter");
      await openChatAgentModel(page);
      await expect(page.getByTestId("chat-agent-option-claude")).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false", {
        timeout: 15000,
      });

      const thread = await apiGet<{
        config: { providerId: string };
        messages: unknown[];
        providerSwitch?: unknown;
      }>(request, `/chat/threads/${threadId}`);
      expect(thread.config.providerId).toBe("claude-two");
      expect(thread.providerSwitch).toBeUndefined();
      expect(thread.messages).toHaveLength(6);
    } finally {
      await restoreProviders(request, initial);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
}
