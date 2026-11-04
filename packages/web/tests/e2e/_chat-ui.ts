import { expect, type Page } from "@playwright/test";

export async function chooseChatAgent(page: Page, agent: string): Promise<void> {
  await page.getByTestId("chat-agent-button").filter({ visible: true }).click();
  await page.getByTestId(`chat-agent-option-${agent}`).click();
}

export async function openChatModel(page: Page): Promise<void> {
  if (!(await page.getByTestId("chat-model-select").isVisible()))
    await page.getByTestId("chat-model-button").filter({ visible: true }).click();
  await expect(page.getByTestId("chat-model-select")).toBeVisible();
}

export async function chooseChatModel(page: Page, model: string): Promise<void> {
  await openChatModel(page);
  await page.getByTestId("chat-model-select").selectOption(model);
  await page.keyboard.press("Escape");
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
