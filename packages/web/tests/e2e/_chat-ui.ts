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

export async function openChatSettings(page: Page): Promise<void> {
  await openChatActions(page);
  await page.getByTestId("chat-config-button").click();
  await expect(page.getByTestId("chat-config-dialog")).toBeVisible();
}

export async function openChatHistory(page: Page): Promise<void> {
  const sidebar = page.getByTestId("chat-session-sidebar");
  const dialog = page.getByTestId("chat-sessions-dialog");
  const button = page.getByTestId("chat-sessions-button");
  // Wait for the chat to render before choosing a branch; sign-in may still be in progress.
  await expect(sidebar.or(dialog).or(button).filter({ visible: true }).first()).toBeVisible();
  if (await sidebar.isVisible()) return;
  if (!(await dialog.isVisible())) await button.filter({ visible: true }).click();
  await expect(page.getByTestId("chat-session-list")).toBeVisible();
}

export async function waitHistoryClosed(page: Page): Promise<void> {
  await expect(page.getByTestId("chat-sessions-dialog")).toBeHidden();
}

export async function closeChatHistory(page: Page): Promise<void> {
  if (await page.getByTestId("chat-sessions-dialog").isVisible())
    await page.keyboard.press("Escape");
}

export async function settingsSection(page: Page, section: string): Promise<void> {
  const mobile = page.getByRole("combobox", { name: "Settings section", exact: true });
  await expect(
    mobile
      .or(page.getByTestId(`settings-section-${section}`))
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  if (await mobile.isVisible()) await mobile.selectOption(section);
  else await page.getByTestId(`settings-section-${section}`).click();
}
