import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { chooseChatAgent, openChatSettings } from "./_chat-ui";
import { API_SECRET, gotoView } from "./_helpers";

for (const width of [390, 1440]) {
  test(`agent-specific launch options apply and survive conversation reopen at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await request.patch("/api/settings", {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: { chat: ChatSettingsSchema.parse({ mcp: "native" }) },
    });
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "dashboard");
    await page.goto("/?chat=open");
    const editor = page.getByTestId("chat-agent-options-input");
    const apply = page.getByTestId("chat-agent-options-apply");
    await chooseChatAgent(page, "gemini");
    await openChatSettings(page);
    await page.getByTestId("chat-agent-options").locator("summary").click();
    await expect(page.getByTestId("chat-agent-options-help")).toContainText("--approve-all");
    await editor.fill('["--format", "text"]');
    await apply.click();
    await expect(page.getByTestId("chat-agent-options-error")).toContainText(
      "Unsupported acpx argument",
    );
    await editor.fill('["--approve-all", "--timeout", "120"]');
    await apply.click();
    await expect(page.getByTestId("chat-agent-options-feedback")).toContainText(
      "start this conversation",
    );
    await page.keyboard.press("Escape");
    await chooseChatAgent(page, "claude");
    await openChatSettings(page);
    await page.getByTestId("chat-agent-options").locator("summary").click();
    await expect(editor).toHaveValue("{}");
    await editor.fill('{"permissionMode":"bypassPermissions","maxTurns":3,"effort":"low"}');
    await apply.click();
    await expect(page.getByTestId("chat-permission-mode")).toHaveValue("bypassPermissions");
    await page.keyboard.press("Escape");
    await chooseChatAgent(page, "gemini");
    const title = `Launch options ${width}`;
    const sent = page.waitForRequest((request) => request.url().endsWith("/api/chat/stream"));
    await page.getByTestId("chat-input").filter({ visible: true }).fill(title);
    await page.getByTestId("chat-send-button").filter({ visible: true }).click();
    expect((await sent).postDataJSON().agentOptions).toMatchObject({
      gemini: { runtime: "acpx", args: ["--approve-all", "--timeout", "120"] },
      claude: {
        runtime: "claude-sdk",
        options: { permissionMode: "bypassPermissions", maxTurns: 3, effort: "low" },
      },
    });
    await expect(page.getByTestId("chat-input").filter({ visible: true })).toBeEnabled();
    await openChatSettings(page);
    await page.getByTestId("chat-agent-options").locator("summary").click();
    await editor.fill('["--deny-all", "--timeout", "20"]');
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/config") && response.request().method() === "PATCH",
    );
    await apply.click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByTestId("chat-agent-options-feedback")).toContainText("Saved");
    await page.screenshot({ path: info.outputPath(`launch-options-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.reload();
    await page.getByTestId("chat-sessions-button").filter({ visible: true }).click();
    await page.getByTestId("chat-session-select").filter({ hasText: title }).click();
    await openChatSettings(page);
    await page.getByTestId("chat-agent-options").locator("summary").click();
    await expect(editor).toHaveValue(JSON.stringify(["--deny-all", "--timeout", "20"], null, 2));
    await page.keyboard.press("Escape");
  });
}
