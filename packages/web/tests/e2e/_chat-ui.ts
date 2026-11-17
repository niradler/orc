import { expect, type Page } from "@playwright/test";

export async function openChatAgentModel(page: Page): Promise<void> {
  if (!(await page.getByTestId("chat-agent-model-picker").isVisible()))
    await page.getByTestId("chat-agent-model-button").filter({ visible: true }).click();
  await expect(page.getByTestId("chat-agent-model-picker")).toBeVisible();
}

export async function chooseChatAgent(page: Page, agent: string): Promise<void> {
  await openChatAgentModel(page);
  const option = page.getByTestId(`chat-agent-option-${agent}`);
  await option.click();
  if (await page.getByTestId("chat-agent-model-picker").isVisible()) {
    await expect(option).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
  }
  await expect(page.getByTestId("chat-agent-model-picker")).toBeHidden();
}

export async function openChatModel(page: Page): Promise<void> {
  await openChatAgentModel(page);
  await expect(page.getByTestId("chat-model-select")).toBeVisible();
}

export async function chooseChatEffort(page: Page, effort: string): Promise<void> {
  await openChatAgentModel(page);
  const option = page.getByTestId(`chat-effort-option-${effort}`);
  await option.click();
  await expect(option).toHaveAttribute("aria-checked", "true");
}

export async function chooseChatModel(page: Page, model: string): Promise<void> {
  await openChatModel(page);
  await page.getByTestId(`chat-model-option-${model}`).click();
  await expect(page.getByTestId("chat-model-select")).toBeHidden();
}

export async function openWorkspaceFolder(page: Page): Promise<void> {
  if (!(await page.getByTestId("chat-workspace-folder-picker").isVisible()))
    await page.getByTestId("chat-workspace-folder").filter({ visible: true }).click();
  await expect(page.getByTestId("chat-workspace-folder-picker")).toBeVisible();
}

export async function closeWorkspaceFolder(page: Page): Promise<void> {
  if (await page.getByTestId("chat-workspace-folder-picker").isVisible())
    await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-workspace-folder-picker")).toBeHidden();
}

export async function chooseWorkspaceHost(page: Page, host: string): Promise<void> {
  await openWorkspaceFolder(page);
  await page.getByTestId("chat-workspace-host-option").filter({ hasText: host }).click();
  await closeWorkspaceFolder(page);
}

export async function setWorkspaceFolder(page: Page, cwd: string): Promise<void> {
  await openWorkspaceFolder(page);
  await page.getByTestId("chat-workspace-cwd").fill(cwd);
  await page.getByTestId("chat-workspace-apply").click();
  await expect(page.getByTestId("chat-workspace-folder-picker")).toBeHidden();
}

export async function browseWorkspace(page: Page): Promise<void> {
  await openWorkspaceFolder(page);
  await page.getByTestId("chat-workspace-browse").click();
}

export async function setWorkspaceWorktree(page: Page, worktree: boolean): Promise<void> {
  const branch = page.getByTestId("chat-workspace-branch");
  await branch.click();
  await page.getByTestId(worktree ? "chat-workspace-worktree" : "chat-workspace-checkout").click();
  await expect(branch).toHaveAttribute("data-worktree", String(worktree));
}

export async function openChatActions(page: Page): Promise<void> {
  if (!(await page.getByTestId("chat-config-button").isVisible()))
    await page.getByTestId("chat-options-button").filter({ visible: true }).click();
}

export async function openChatSettings(
  page: Page,
  tab: "overview" | "customize" = "overview",
): Promise<void> {
  await openChatActions(page);
  await page.getByTestId("chat-config-button").click();
  await expect(page.getByTestId("chat-config-dialog")).toBeVisible();
  if (tab !== "overview") await page.getByTestId(`chat-settings-tab-${tab}`).click();
}

export async function showSessionSection(
  page: Page,
  section: "projects" | "recents",
): Promise<void> {
  const tab = page.getByTestId(`session-navigation-${section}`).filter({ visible: true }).first();
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

export async function openChatHistory(
  page: Page,
  section: "projects" | "recents" = "recents",
): Promise<void> {
  const sidebar = page.getByTestId("chat-session-sidebar");
  const dialog = page.getByTestId("chat-sessions-dialog");
  const button = page.getByTestId("chat-sessions-button");
  // Wait for the chat to render before choosing a branch; sign-in may still be in progress.
  await expect(sidebar.or(dialog).or(button).filter({ visible: true }).first()).toBeVisible();
  if (await sidebar.isVisible()) {
    await showSessionSection(page, section);
    return;
  }
  if (!(await dialog.isVisible())) await button.filter({ visible: true }).click();
  await showSessionSection(page, section);
  await expect(
    page.getByTestId(section === "recents" ? "chat-session-list" : "session-project-list"),
  ).toBeVisible();
}

export async function waitHistoryClosed(page: Page): Promise<void> {
  await expect(page.getByTestId("chat-sessions-dialog")).toBeHidden();
}

export async function closeChatHistory(page: Page): Promise<void> {
  if (await page.getByTestId("chat-sessions-dialog").isVisible())
    await page.keyboard.press("Escape");
}

/** Old section ids still used by tests and bookmarks, mapped onto the grouped settings panels. */
const settingsTargets: Record<
  string,
  { group: string; agentsTab?: string; connectionsTab?: string }
> = {
  connection: { group: "hosts" },
  appearance: { group: "general" },
  terminals: { group: "general" },
  browser: { group: "general" },
  execution: { group: "hosts" },
  agents: { group: "agents" },
  chat: { group: "agents", agentsTab: "chat" },
  mcp: { group: "agents", agentsTab: "mcp" },
  channels: { group: "connections", connectionsTab: "channels" },
  integrations: { group: "connections", connectionsTab: "integrations" },
  server: { group: "about" },
  storage: { group: "about" },
  attention: { group: "notifications" },
};

export async function settingsSection(page: Page, section: string): Promise<void> {
  const target = settingsTargets[section] ?? { group: section };
  const back = page.getByTestId("settings-back");
  const phoneItem = page.getByTestId(`settings-list-${target.group}`);
  const navItem = page.getByTestId(`settings-section-${target.group}`);
  // Wait through the sign-in check. A phone shows either the section list or an open panel.
  await expect(phoneItem.or(navItem).or(back).filter({ visible: true }).first()).toBeVisible();
  if (await back.isVisible()) {
    // A panel may already be open; return to the list only to reach a different group.
    const openGroup = await page.getByTestId("settings-detail").getAttribute("data-group");
    if (openGroup !== target.group) {
      await back.click();
      await expect(phoneItem).toBeVisible();
    }
  }
  if (await phoneItem.isVisible()) {
    await phoneItem.click();
    await expect(back).toBeVisible();
  } else if (await navItem.isVisible()) {
    await navItem.click();
  }
  if (target.agentsTab) {
    const tab = page.getByTestId(`agents-tab-${target.agentsTab}`);
    await expect(tab).toBeVisible();
    await tab.click();
  }
  if (target.connectionsTab) {
    const tab = page.getByTestId(`connections-tab-${target.connectionsTab}`);
    await expect(tab).toBeVisible();
    await tab.click();
  }
}
