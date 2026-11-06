import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, type Page, test } from "@playwright/test";
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
      "Ask anything. / for prompts and skills",
    );
    await expect(tools.getByTestId("chat-permission-chip")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

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
});

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
  await expect(chip).toHaveText("Allow edits");
  await expect(chip).toHaveAccessibleName("Permissions: Allow edits");
  await chip.click();
  await expect(page.getByTestId("chat-permission-option-acceptEdits")).toBeFocused();
  await page.getByTestId("chat-permission-option-bypassPermissions").click();
  await expect(chip).toHaveAttribute("data-mode", "bypassPermissions");
  await chip.click();
  await page.getByTestId("chat-permission-option-default").click();
  await expect(chip).toHaveCount(0);
});
