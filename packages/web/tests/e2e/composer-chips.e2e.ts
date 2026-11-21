import { ChatSettingsSchema } from "@orc/core/chat";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };
const defaults = ChatSettingsSchema.parse({});
const PROJECT = "/work/orc-project";
const OLDER = "/work/older-service";

test.beforeEach(async ({ page, request }) => {
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
  await page.route("**/api/chat/models?**", (route) => {
    const agent = new URL(route.request().url()).searchParams.get("agent");
    return route.fulfill({
      json: {
        models: [
          { id: `${agent}-fast`, label: `${agent} fast` },
          { id: `${agent}-deep`, label: `${agent} deep` },
        ],
        warning: null,
      },
    });
  });
  await page.route("**/api/ssh", (route) =>
    route.fulfill({ json: { host: null, hosts: [], supported: true } }),
  );
  await page.route("**/api/git/worktrees?**", (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd") ?? "";
    return route.fulfill({
      json: {
        root: cwd,
        worktrees: [{ path: cwd, branch: "refs/heads/feature/chips", main: true }],
      },
    });
  });
  await page.route("**/api/git/branches?**", (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd") ?? "";
    return route.fulfill({
      json: {
        root: cwd,
        current: "feature/chips",
        default_branch: "origin/main",
        local: ["feature/chips", "main"],
        remote: ["origin/main", "origin/release"],
      },
    });
  });
  await page.addInitScript(
    ({ secret, recent }) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
      localStorage.setItem(
        "orc_folder_history",
        JSON.stringify({ local: { last: recent[0], recent } }),
      );
    },
    { secret: API_SECRET, recent: [PROJECT, OLDER] },
  );
});
test.afterEach(async ({ request }) => {
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
});

async function openChat(page: Page) {
  await page.goto("/?chat=open");
  await expect(page.getByTestId("chat-input")).toBeEnabled();
}

async function paste(page: Page, text: string) {
  await page.getByTestId("chat-input").evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

for (const width of [1440, 390]) {
  test(`composer shows project, branch and agent+model chips without raw paths at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openChat(page);
    const tools = page.getByTestId("chat-composer-tools");
    await expect(tools.getByTestId("chat-workspace-folder")).toHaveText("orc-project");
    await expect(tools.getByTestId("chat-workspace-branch")).toHaveText("feature/chips");
    await expect(tools.getByTestId("chat-agent-model-button")).toHaveAccessibleName(
      /^Agent and model: Codex, Agent default/,
    );
    await expect(tools).not.toContainText(PROJECT);
    await expect(tools.getByTestId("chat-workspace-folder")).toHaveAccessibleName(
      new RegExp(PROJECT),
    );
    await expect(page.getByTestId("chat-input")).toHaveAttribute(
      "placeholder",
      "Ask anything. / for commands, @ for files",
    );
    await expect(tools.getByTestId("chat-permission-chip")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

for (const width of [320, 390, 820, 1440]) {
  test(`compact controls fit a narrow composer and expand only with room at ${width}px`, async ({
    page,
    request,
  }) => {
    await request.patch("/api/settings", {
      headers,
      data: { chat: { ...defaults, permissionMode: "acceptEdits" } },
    });
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["dark", "light"]) {
      await request.patch("/api/settings", { headers, data: { theme } });
      await openChat(page);
      const input = page.getByTestId("chat-input");
      await input.fill("Keep this draft while the composer changes size");
      const folder = page.getByTestId("chat-workspace-folder");
      const agent = page.getByTestId("chat-agent-model-button");
      const branch = page.getByTestId("chat-workspace-branch");
      const permission = page.getByTestId("chat-permission-chip");
      await expect(permission).toBeVisible();
      const compact = width !== 820;
      for (const label of [
        folder.getByTestId("chat-workspace-folder-name"),
        agent.getByTestId("chat-agent-current"),
        agent.getByTestId("chat-model-current"),
      ]) {
        if (compact) await expect(label).toBeHidden();
        else await expect(label).toBeVisible();
      }
      const row = await agent.boundingBox();
      for (const control of [folder, agent, branch, permission]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        if (compact) expect(bounds?.width).toBe(width < 640 ? 44 : 32);
        else expect(bounds?.width).toBeGreaterThan(32);
        expect(Math.abs((bounds?.y ?? 0) - (row?.y ?? 0))).toBeLessThanOrEqual(1);
        if (width < 640) expect(bounds?.height).toBeGreaterThanOrEqual(44);
      }
      await folder.click();
      await expect(page.getByTestId("chat-workspace-full-path")).toContainText(PROJECT);
      await page.keyboard.press("Escape");
      await expect(folder).toBeFocused();
      await agent.click();
      await expect(page.getByTestId("chat-agent-model-picker")).toBeVisible();
      await expect(page.getByTestId("chat-model-option-default")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await page.keyboard.press("Escape");
      await expect(agent).toBeFocused();
      await expect(input).toHaveValue("Keep this draft while the composer changes size");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(page.getByTestId("chat-send-button")).toBeVisible();
      if (width === 390)
        await page.screenshot({ path: test.info().outputPath(`compact-${theme}-390.png`) });
      if (width === 1440) {
        await page.getByTestId("chat-fullscreen-button").click();
        await expect(folder.getByTestId("chat-workspace-folder-name")).toBeVisible();
        await expect(agent.getByTestId("chat-agent-current")).toBeVisible();
        await expect(agent.getByTestId("chat-model-current")).toBeVisible();
        await expect(input).toHaveValue("Keep this draft while the composer changes size");
        await page.screenshot({ path: test.info().outputPath(`wide-${theme}-1440.png`) });
        if (theme === "dark") {
          await agent.click();
          await expect(page.getByTestId("chat-agent-model-picker")).toBeVisible();
          await page.screenshot({ path: test.info().outputPath("agent-model-picker.png") });
          await page.keyboard.press("Escape");
        }
        await page.goBack();
        await expect(agent.getByTestId("chat-model-current")).toBeHidden();
      }
    }
  });
}

const MODEL_SCENARIOS = [
  {
    agent: "claude",
    id: "claude-opus-4-6[1m]",
    label: "Claude Opus 4.6 (1M context) with extended thinking",
    short: "Opus 4.6",
  },
  {
    agent: "codex",
    id: "gpt-5.2-codex",
    label: "GPT-5.2 Codex with max reasoning",
    short: "GPT-5.2 Codex",
  },
  {
    agent: "opencode",
    id: "qwen3-max-preview",
    label: "Qwen3 Max Preview (thinking)",
    short: "Qwen3 Max Preview",
  },
] as const;
const LONG_MODEL = MODEL_SCENARIOS[0];

async function seedModel(
  page: Page,
  request: APIRequestContext,
  scenario: (typeof MODEL_SCENARIOS)[number],
) {
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [scenario], warning: null } }),
  );
  await request.patch("/api/settings", {
    headers,
    data: { chat: { ...defaults, agent: scenario.agent, model: scenario.id } },
  });
}

test("@sanity long model names stay readable in the composer chip and picker", async ({
  page,
  request,
}) => {
  for (const width of [1440, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const scenarios = width === 1440 ? MODEL_SCENARIOS : [LONG_MODEL];
    for (const scenario of scenarios) {
      await seedModel(page, request, scenario);
      await openChat(page);
      const chip = page.getByTestId("chat-agent-model-button");
      if (width === 1440) await page.getByTestId("chat-fullscreen-button").click();
      if (width === 390) {
        // Compact composer keeps the approved icon-only row; the full name stays
        // in the accessible name and one tap away in the picker.
        await expect(chip.getByTestId("chat-model-current")).toBeHidden();
        await expect(page.getByTestId("chat-model-help")).toBeHidden();
        const bounds = await chip.boundingBox();
        expect(bounds?.width).toBe(44);
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
        expect(await chip.getAttribute("aria-label")).toContain(scenario.label);
        await page.screenshot({ path: test.info().outputPath(`long-model-${width}.png`) });
        await chip.click();
        await expect(page.getByTestId("chat-picker-tab-model")).toHaveAttribute(
          "aria-label",
          `Model: ${scenario.label}`,
        );
      } else {
        // The chip shows the core name; the rest lives in the help popover.
        const bounds = await chip.boundingBox();
        expect(bounds?.width).toBeLessThanOrEqual(256);
        await expect(chip.getByTestId("chat-model-current")).toHaveText(scenario.short);
        const help = page.getByTestId("chat-model-help");
        await help.hover();
        const content = page.getByTestId("chat-model-help-content");
        await expect(content).toBeVisible();
        await expect(page.getByTestId("chat-model-help-name")).toHaveText(scenario.label);
        await page.screenshot({
          path: test.info().outputPath(`chip-${scenario.agent}-${width}.png`),
        });
        await chip.click();
        await expect(content).toBeHidden();
      }
      const option = page.getByTestId(`chat-model-option-${scenario.id}`);
      await expect(option).toContainText(scenario.label);
      expect(
        await option
          .locator("span")
          .first()
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("chat-send-button")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});

test.describe("touch composer", () => {
  test.use({ hasTouch: true });
  test("long model names scroll sideways in the chip without a scrollbar", async ({
    page,
    request,
  }) => {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const raw = {
      agent: "opencode",
      id: "some-provider/very-long-custom-model-identifier-with-many-words-0123456789",
      label: "some-provider/very-long-custom-model-identifier-with-many-words-0123456789",
    };
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [raw], warning: null } }),
    );
    await request.patch("/api/settings", {
      headers,
      data: { chat: { ...defaults, agent: raw.agent, model: raw.id } },
    });
    await page.setViewportSize({ width: 820, height: 900 });
    await openChat(page);
    const model = page.getByTestId("chat-model-current");
    await expect(model).toBeVisible();
    const state = await model.evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
      scrollable: element.scrollWidth > element.clientWidth,
    }));
    expect(state).toEqual({ overflowX: "auto", scrollbarWidth: "none", scrollable: true });
    await model.evaluate((element) => {
      element.scrollLeft = 80;
    });
    expect(await model.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath("long-model-touch-820.png") });
    await page.getByTestId("chat-model-help").tap();
    await expect(page.getByTestId("chat-model-help-name")).toHaveText(raw.label);
    await page.getByTestId("chat-agent-model-button").tap();
    await expect(page.getByTestId("chat-agent-model-picker")).toBeVisible();
    await expect(page.getByTestId(`chat-model-option-${raw.id}`)).toContainText(raw.label);
  });
});

test("folder changes in two clicks and agent+model change from one pill", async ({ page }) => {
  await openChat(page);
  const folder = page.getByTestId("chat-workspace-folder");
  await folder.click();
  await page.getByTestId("chat-workspace-recent-option").filter({ hasText: OLDER }).click();
  await expect(page.getByTestId("chat-workspace-folder-picker")).toBeHidden();
  await expect(folder).toHaveText("older-service");
  await expect(folder).toHaveAttribute("title", `Local: ${OLDER}`);

  const pill = page.getByTestId("chat-agent-model-button");
  await pill.click();
  await expect(page.getByTestId("chat-agent-select")).toBeVisible();
  await expect(page.getByTestId("chat-model-select")).toBeVisible();
  await page.getByTestId("chat-agent-option-claude").click();
  await expect(page.getByTestId("chat-agent-option-claude")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByTestId("chat-model-option-claude-deep").click();
  await expect(page.getByTestId("chat-agent-model-picker")).toBeHidden();
  await expect(page.getByTestId("chat-agent-current")).toHaveText("Claude Code");
  await expect(page.getByTestId("chat-model-current")).toHaveText("claude deep");
});

test("composer chips are fully keyboard operable", async ({ page }) => {
  await openChat(page);
  const pill = page.getByTestId("chat-agent-model-button");
  await pill.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-agent-option-codex")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("chat-model-option-default")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByTestId("chat-model-option-custom")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("chat-model-option-codex-deep")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-agent-model-picker")).toBeHidden();
  await expect(page.getByTestId("chat-model-current")).toHaveText("codex deep");
  await expect(pill).toBeFocused();

  await page.keyboard.press("Tab");
  const folder = page.getByTestId("chat-workspace-folder");
  await expect(folder).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-workspace-copy-path")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByTestId("chat-workspace-browse")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("chat-workspace-recent-option").last()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-workspace-folder-picker")).toBeHidden();
  await expect(folder).toHaveAttribute("title", `Local: ${OLDER}`);
  await expect(folder).toBeFocused();

  await page.keyboard.press("Tab");
  const branch = page.getByTestId("chat-workspace-branch");
  await expect(branch).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-workspace-checkout")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("chat-workspace-worktree")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(branch).toHaveAttribute("data-worktree", "true");
  await expect(branch).toHaveText("New worktree from feature/chips");
  await expect(branch).toBeFocused();

  await branch.press("Enter");
  await expect(page.getByTestId("chat-workspace-worktree")).toBeFocused();
  await expect(page.getByTestId("chat-workspace-default-worktree")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("chat-workspace-default-worktree")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("chat-workspace-base")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-workspace-base-back")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("chat-workspace-base-option").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-workspace-branch-picker")).toBeHidden();
  await expect(branch).toBeFocused();
});

for (const width of [1440, 390]) {
  test(`run-in starts a worktree from the default branch or any chosen branch at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
    await openChat(page);
    await page.getByTestId("chat-input").fill("Start from a clean base");
    const branch = page.getByTestId("chat-workspace-branch");
    const picker = page.getByTestId("chat-workspace-branch-picker");
    await branch.click();
    await expect(page.getByTestId("chat-workspace-checkout")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByTestId("chat-workspace-default-worktree").click();
    await expect(branch).toHaveText("New worktree from origin/main");
    await expect(branch).toHaveAttribute("data-worktree", "true");

    await branch.click();
    await expect(page.getByTestId("chat-workspace-default-worktree")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByTestId("chat-workspace-base").click();
    await expect(page.getByTestId("chat-workspace-base-back")).toBeVisible();
    await page.getByTestId("chat-workspace-base-filter").fill("release");
    await expect(page.getByTestId("chat-workspace-base-option")).toHaveCount(1);
    await page.getByTestId("chat-workspace-base-option").click();
    await expect(branch).toHaveText("New worktree from origin/release");
    await expect(picker).toBeHidden();

    await branch.click();
    await expect(page.getByTestId("chat-workspace-base")).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: test.info().outputPath(`run-in-${width}.png`) });
    await page.keyboard.press("Escape");

    await page.getByTestId("chat-workspace-folder").click();
    await page.getByTestId("chat-workspace-recent-option").filter({ hasText: OLDER }).click();
    await expect(page.getByTestId("chat-workspace-folder-picker")).toBeHidden();
    await expect(branch).toHaveText("New worktree from feature/chips");
    await expect(branch).toHaveAttribute("data-worktree", "true");
    await branch.click();
    await page.getByTestId("chat-workspace-base").click();
    await page.getByTestId("chat-workspace-base-filter").fill("release");
    await page.getByTestId("chat-workspace-base-option").click();
    await expect(branch).toHaveText("New worktree from origin/release");

    let launch: unknown;
    await page.route("**/api/chat/stream", (route) => {
      launch = route.request().postDataJSON();
      return route.fulfill({ status: 400, json: { error: "Captured base-branch launch" } });
    });
    await page.getByTestId("chat-send-button").click();
    await expect
      .poll(() => launch)
      .toMatchObject({
        workspace: { worktree: true, base: "origin/release" },
      });
  });
}

test("long pastes become a text attachment unless pasted as plain text", async ({ page }) => {
  await openChat(page);
  const input = page.getByTestId("chat-input");
  await input.fill("Review this log");
  const long = Array.from({ length: 240 }, (_, index) => `line ${index}`).join("\n");
  await paste(page, long);
  await expect(page.getByTestId("chat-attachments")).toContainText("pasted-text-1.txt");
  await expect(input).toHaveValue("Review this log");

  await paste(page, "short snippet");
  await expect(page.getByTestId("chat-attachments").locator("li")).toHaveCount(1);

  await input.dispatchEvent("keydown", { key: "V", ctrlKey: true, shiftKey: true });
  await paste(page, long);
  await expect(page.getByTestId("chat-attachments").locator("li")).toHaveCount(1);

  await paste(page, long);
  await expect(page.getByTestId("chat-attachments")).toContainText("pasted-text-2.txt");
});

test("permission chip appears only when the mode is not the default", async ({ page, request }) => {
  await request.patch("/api/settings", {
    headers,
    data: { chat: { ...defaults, permissionMode: "acceptEdits" } },
  });
  await openChat(page);
  const chip = page.getByTestId("chat-permission-chip");
  await expect(chip).toHaveText("Auto");
  await expect(chip).toHaveAccessibleName("Permissions: Auto");
  await chip.click();
  await expect(page.getByTestId("chat-permission-option-acceptEdits")).toBeFocused();
  await page.getByTestId("chat-permission-option-bypassPermissions").click();
  await expect(chip).toHaveAttribute("data-mode", "bypassPermissions");
  await chip.click();
  await page.getByTestId("chat-permission-option-default").click();
  await expect(chip).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`each agent lists only its own permission modes, with descriptions, at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await request.patch("/api/settings", {
      headers,
      data: { chat: { ...defaults, agent: "claude", permissionMode: "plan" } },
    });
    await openChat(page);
    const chip = page.getByTestId("chat-permission-chip");
    await expect(chip).toHaveAttribute("data-mode", "plan");
    await expect(chip).toHaveAccessibleName("Permissions: Plan");
    await chip.click();
    const plan = page.getByTestId("chat-permission-option-plan");
    await expect(plan).toHaveAttribute("aria-checked", "true");
    await expect(plan).toContainText("Reads and plans, never edits");
    const box = await page.getByRole("menu", { name: "Permissions" }).boundingBox();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);
    await page.getByTestId("chat-permission-option-acceptEdits").click();
    await expect(chip).toHaveAttribute("data-mode", "acceptEdits");

    await page.getByTestId("chat-agent-model-button").click();
    if (width < 640) await page.getByTestId("chat-picker-tab-agent").click();
    await page.getByTestId("chat-agent-option-codex").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-agent-model-picker")).toBeHidden();
    await chip.click();
    await expect(page.getByTestId("chat-permission-option-plan")).toBeVisible();
    await expect(page.getByTestId("chat-permission-option-auto")).toContainText(
      "Workspace only, reviewer decides",
    );
    await page.keyboard.press("Escape");

    await page.evaluate(() => localStorage.clear());
    await request.patch("/api/settings", {
      headers,
      data: {
        chat: { ...defaults, agent: "opencode", permissionMode: "plan" },
      },
    });
    await openChat(page);
    await expect(chip).toHaveAttribute("data-mode", "plan");
    await chip.click();
    await expect(
      page.getByRole("menu", { name: "Permissions" }).getByRole("menuitemradio"),
    ).toHaveCount(2);
    await page.getByTestId("chat-permission-option-default").click();
    await expect(chip).toHaveCount(0);
  });
}

test("backend capabilities lock the model column and hide the permission chip", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    headers,
    data: { chat: { ...defaults, permissionMode: "acceptEdits" } },
  });
  await page.route("**/api/chat/capabilities?**", (route) =>
    route.fulfill({
      json: {
        backend: "acpx",
        capabilities: {
          version: 1,
          source: "adapter",
          resume: false,
          modelSelection: false,
          images: false,
          toolOutput: true,
          approvals: false,
          questions: false,
          livePermissions: false,
          interrupt: false,
          steering: false,
          mcp: false,
          fork: false,
          rollback: false,
        },
      },
    }),
  );
  await openChat(page);
  await page.getByTestId("chat-agent-model-button").click();
  await expect(page.getByTestId("chat-model-option-default")).toBeDisabled();
  await expect(page.getByTestId("chat-model-option-custom")).toBeDisabled();
  await page.getByTestId("chat-agent-model-help").click();
  await expect(page.getByTestId("chat-agent-model-note")).toContainText("picks its own model");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-permission-chip")).toHaveCount(0);
});
