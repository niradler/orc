import { ChatSettingsSchema } from "@orc/core/chat";
import { expect } from "@playwright/test";
import { API_SECRET, apiPost, gotoView } from "./_helpers";
import { test } from "./_terminal-fixture";

test("phone keyboard text reaches a real terminal without keydown", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    const terminal = await apiPost<{ id: string }>(request, "/terminals", {
      kind: "shell",
      host: null,
    });
    let output = "";
    const sent: string[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        output += payload.toString();
      });
      socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") sent.push(payload.toString());
      });
    });
    await page.addInitScript(
      (secret) =>
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
      API_SECRET,
    );
    await page.goto(`/terminals/${terminal.id}?project=all`);
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible();
    await expect.poll(() => output.length).toBeGreaterThan(0);
    // On a phone the selectable text lies over the canvas, so the tap lands on the surface.
    await page.getByTestId("terminal-surface").first().tap();
    const input = page.locator("textarea[aria-label='Terminal input']").first();
    await expect(input).toBeFocused();
    // Android/iOS software keyboards may supply only InputEvents (keyCode 229): the edit
    // is announced by beforeinput and then applied natively to the textarea.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.insertText", { text: "echo MOBILE" });
    await cdp.send("Input.insertText", { text: "X" });
    await input.evaluate((element: HTMLTextAreaElement) => {
      const native = (inputType: string, apply: () => void) => {
        const before = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType,
        });
        if (!element.dispatchEvent(before)) return;
        apply();
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
      };
      native("deleteContentBackward", () => {
        element.value = element.value.slice(0, -1);
      });
    });
    await cdp.send("Input.insertText", { text: "_INPUT_OK" });
    await input.evaluate((element) =>
      element.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertLineBreak",
        }),
      ),
    );
    await expect.poll(() => sent.join("")).toContain("echo MOBILEX\x7f_INPUT_OK\r");
    await expect.poll(() => output).toContain("MOBILE_INPUT_OK");
    // Physical keys and IME commits each travel once.
    sent.length = 0;
    await input.press("a");
    await expect.poll(() => sent.join("")).toBe("a");
    await cdp.send("Input.imeSetComposition", {
      text: "שלום",
      selectionStart: 4,
      selectionEnd: 4,
    });
    await cdp.send("Input.insertText", { text: "שלום" });
    await expect.poll(() => sent.join("")).toBe("aשלום");
    await page.waitForTimeout(300);
    expect(sent.join("")).toBe("aשלום");
  } finally {
    await context.close();
  }
});

for (const width of [1440, 390]) {
  test(`Sessions defaults to chat resume and preserves server ownership errors at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const session = {
      id: "resume-chat-fixture",
      session_id: "native-fixture",
      agent: "codex",
      name: "Earlier coding work",
      cwd: "/fixture",
      status: "stopped",
      project_id: null,
      last_activity_at: Date.now(),
      tokens_used: null,
      tokens_estimated: false,
    };
    const thread = {
      id: "00000000-0000-4000-8000-000000000111",
      title: session.name,
      config: ChatSettingsSchema.parse({ agent: "codex" }),
      cwd: session.cwd,
      host: null,
      backend: "codex-cli",
      runtimeId: session.session_id,
      sourceId: session.id,
      messages: [
        {
          id: "earlier",
          role: "assistant",
          content: "Native history restored",
          timestamp: Date.now(),
          agent: "codex",
        },
      ],
      updatedAt: Date.now(),
    };
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({ json: { sessions: [session] } }),
    );
    let reject = true;
    await page.route("**/api/chat/threads", (route) => {
      expect(route.request().postDataJSON()).toEqual({ sourceSessionId: session.id });
      if (reject) {
        reject = false;
        return route.fulfill({ status: 409, json: { error: "Session is still active" } });
      }
      return route.fulfill({ json: thread });
    });
    await gotoView(page, "sessions");
    await expect(page.getByTestId("open-chat-resume")).toHaveText("Resume");
    await expect(page.getByTestId("open-terminal-resume")).toHaveCount(0);
    await page.getByTestId("resume-actions-menu").click();
    await expect(page.getByTestId("open-terminal-resume")).toHaveText("Terminal");
    await page.keyboard.press("Escape");
    await page.getByTestId("open-chat-resume").click();
    await expect(page.getByRole("alert")).toContainText("Session is still active");
    await page.goto(`/sessions?project=all&session=${session.id}`);
    const detail = page.getByTestId("live-session-detail");
    await expect(detail).toBeVisible();
    await detail.getByTestId("open-chat-resume").click();
    await expect(detail).toBeHidden();
    await expect(page.getByTestId("chat-panel").filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId("chat-message-content").filter({ visible: true })).toContainText(
      "Native history restored",
    );
    await expect(page.getByTestId("chat-input").filter({ visible: true })).toBeEnabled();
    await expect(page).toHaveURL(/chat=open/);
    await page.screenshot({ path: testInfo.outputPath(`chat-resume-${width}.png`) });
  });
}

test("stale status does not disable supported native agents and Cursor IDE is explained", async ({
  page,
}) => {
  const sessions = ["codex", "claude", "gemini", "cursor-agent", "cursor"].map((agent, index) => ({
    id: agent,
    agent,
    session_id: `native-${agent}`,
    name: agent,
    cwd: "/fixture",
    status: "idle",
    project_id: null,
    last_activity_at: Date.now() - index * 1000,
    tokens_used: null,
  }));
  await page.route("**/api/sessions/live?**", (route) => route.fulfill({ json: { sessions } }));
  await gotoView(page, "sessions");
  const buttons = page.getByTestId("open-chat-resume");
  await expect(buttons).toHaveCount(4);
  for (const button of (await buttons.all()).slice(0, 3)) {
    await expect(button).toHaveText("Resume");
    await expect(button).toBeEnabled();
  }
  await expect(buttons.nth(3)).toBeDisabled();
  await expect(page.getByTestId("chat-resume-unavailable")).toContainText(
    "separate session stores",
  );
  await expect(page.getByTestId("resume-unavailable")).toContainText("Cursor IDE");
});
