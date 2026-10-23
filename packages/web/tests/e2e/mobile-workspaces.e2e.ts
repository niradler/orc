import { expect, type Locator, type Page } from "@playwright/test";
import { API_SECRET, apiPost, gotoView, tid } from "./_helpers";
import { test } from "./_terminal-fixture";

async function fitsViewport(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error("Expected a visible target and a sized viewport");
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
}

async function touchTarget(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
}

for (const theme of ["dark", "light"] as const) {
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 820, height: 1180 },
  ]) {
    test.describe(`${theme} touch ${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport, hasTouch: true, isMobile: true });
      test.beforeEach(async ({ page, request }) => {
        await request.patch("/api/settings", {
          headers: { Authorization: `Bearer ${API_SECRET}` },
          data: { theme },
        });
        await page.addInitScript(
          ({ secret, theme }) => {
            localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
            localStorage.setItem("orc_theme", theme);
          },
          { secret: API_SECRET, theme },
        );
      });

      test("chat streams in a readable sheet and touch navigation preserves the conversation", async ({
        page,
      }, testInfo) => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/api/chat/stream", async (route) => {
          await gate;
          await route.fulfill({
            contentType: "text/event-stream",
            body: 'data: {"type":"text","text":"Mobile streaming response ✓"}\n\ndata: {"type":"done"}\n\n',
          });
        });
        await page.goto("/knowledge/base?sentinel=keep");
        await page.getByTestId("chat-open-button").tap();
        const sheet = page.getByTestId("mobile-chat-sheet");
        await expect(sheet).toBeVisible();
        expect(await sheet.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        await fitsViewport(page, sheet);
        const input = sheet.getByTestId("chat-input");
        await input.fill("A question from my phone");
        await touchTarget(sheet.getByTestId("chat-agent-select"));
        await touchTarget(sheet.getByTestId("chat-send-button"));
        await sheet.getByTestId("chat-send-button").tap();
        await expect(sheet.getByTestId("chat-activity-status")).toBeVisible();
        await expect(sheet.getByTestId("chat-cancel-button")).toBeVisible();
        release();
        await expect(sheet.getByTestId("chat-message-content").last()).toContainText(
          "Mobile streaming response ✓",
        );
        await sheet.getByRole("button", { name: "Close chat", exact: true }).tap();
        await expect(sheet).toBeHidden();
        await page.getByTestId("chat-open-button").tap();
        await expect(sheet).toContainText("Mobile streaming response ✓");
        expect(new URL(page.url()).searchParams.get("sentinel")).toBe("keep");
        await page.screenshot({ path: testInfo.outputPath("chat-touch.png") });
      });

      test("knowledge browser traps focus and document details and editing stay reachable", async ({
        page,
        request,
      }, testInfo) => {
        const kb = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
          name: tid("mobile-knowledge"),
          project_id: null,
        });
        const doc = await apiPost<{ id: string }>(request, `/kb/bases/${kb.id}/documents`, {
          title: "A knowledge document with a long title for small screens",
          content:
            "# A knowledge document with a long title for small screens\n\n## Touch guide\n\nA readable document on a phone.\n\n```text\n" +
            "long-code-".repeat(35) +
            "\n```\n\n" +
            "A paragraph of knowledge.\n\n".repeat(30),
        });
        await page.goto(`/knowledge/base?kb=${kb.id}&document=${doc.id}`);
        await expect(page.getByTestId("kb-document-title")).toBeVisible();
        await page.getByTestId("kb-browser-open").tap();
        const browser = page.getByTestId("kb-mobile-browser");
        await expect(browser).toBeVisible();
        await fitsViewport(page, browser);
        await expect(browser.getByTestId("kb-search-input")).toBeFocused();
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press("Tab");
          expect(await browser.evaluate((node) => node.contains(document.activeElement))).toBe(
            true,
          );
        }
        await touchTarget(browser.getByTestId("kb-browser-close"));
        await browser.getByTestId("kb-browser-close").tap();
        await expect(page.getByTestId("kb-browser-open")).toBeFocused();
        await page.getByTestId("kb-details-toggle").tap();
        const details = page.getByTestId("kb-document-details");
        await expect(details).toBeVisible();
        await fitsViewport(page, page.getByRole("dialog"));
        await touchTarget(page.getByTestId("sheet-close"));
        await page.getByTestId("sheet-close").tap();
        await page.getByTestId("markdown-mode-edit").tap();
        await expect(page).toHaveURL(/editorMode=edit/);
        await page
          .getByTestId("kb-document-content")
          .fill("# Mobile saved guide\n\nSaved with touch controls.");
        await touchTarget(page.getByTestId("document-save"));
        await page.getByTestId("document-save").tap();
        await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
        await page.getByTestId("markdown-mode-read").tap();
        await expect(page.getByTestId("markdown-preview")).toContainText(
          "Saved with touch controls.",
        );
        await page.reload();
        await expect(page.getByTestId("markdown-preview")).toContainText(
          "Saved with touch controls.",
        );
        await fitsViewport(page, page.getByTestId("knowledge-bases"));
        await page.screenshot({ path: testInfo.outputPath("knowledge-touch.png") });
      });

      test("terminal touch keys reach the real shell and pane switches keep its socket", async ({
        page,
        request,
      }, testInfo) => {
        const terminal = await apiPost<{ id: string }>(request, "/terminals", { kind: "shell" });
        let sockets = 0;
        const keys: string[] = [];
        page.on("websocket", (socket) => {
          if (!socket.url().includes(`/terminals/${terminal.id}/ws`)) return;
          sockets++;
          socket.on("framesent", ({ payload }) => {
            keys.push(payload.toString());
          });
        });
        await page.goto(`/terminals/${terminal.id}`);
        const controls = page.getByTestId("terminal-touch-controls");
        await expect(controls).toBeVisible();
        const escapeKey = controls.getByRole("button", { name: "Escape", exact: true });
        await expect(escapeKey).toBeEnabled();
        for (const name of ["Escape", "Tab", "Interrupt command", "Arrow up"]) {
          const button = controls.getByRole("button", { name, exact: true });
          await touchTarget(button);
          await button.tap();
        }
        expect(keys).toContain("\u001b");
        expect(keys).toContain("\t");
        expect(keys).toContain("\u0003");
        expect(keys.some((key) => key === "\u001b[A" || key === "\u001bOA")).toBe(true);
        const gesture = await page.getByTestId("terminal-viewport").evaluate((viewport) => {
          const canvas = viewport.querySelector("canvas");
          if (!canvas) throw new Error("The real terminal canvas is missing");
          const previousFocus = document.activeElement;
          const deltas: number[] = [];
          viewport.addEventListener("wheel", (event) => deltas.push(event.deltaY), {
            capture: true,
          });
          const box = canvas.getBoundingClientRect();
          // Event properties keep synthetic gesture fixtures compatible with WebKit.
          const touch = (type: string, y?: number) =>
            Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
              touches:
                y === undefined ? [] : [{ identifier: 7, clientX: box.left + 20, clientY: y }],
            });
          canvas.dispatchEvent(touch("touchstart", box.top + 30));
          canvas.dispatchEvent(touch("touchmove", box.top + 90));
          canvas.dispatchEvent(touch("touchend"));
          return { deltas, sameFocus: document.activeElement === previousFocus };
        });
        expect(gesture.deltas).toEqual([-60]);
        expect(gesture.sameFocus).toBe(true);
        const pane = page.getByTestId("workspace-pane").filter({ visible: true });
        if (await pane.getByTestId("pane-split-horizontal").isVisible()) {
          await pane.getByTestId("pane-split-horizontal").tap();
        } else {
          await pane.getByTestId("pane-actions").tap();
          await pane.getByTestId("pane-action-split-horizontal").tap();
        }
        await expect(page.getByTestId("mobile-workspace-pane")).toHaveCount(2);
        await expect(page.getByTestId("workspace-pane").filter({ visible: true })).toHaveCount(1);
        await page.getByTestId("mobile-workspace-pane").first().tap();
        await expect(controls).toBeVisible();
        expect(sockets).toBe(1);
        await fitsViewport(page, page.getByTestId("terminal-viewport"));
        await fitsViewport(page, controls);
        expect((await page.getByTestId("terminal-viewport").boundingBox())?.height).toBeGreaterThan(
          100,
        );
        await page.screenshot({ path: testInfo.outputPath("terminal-touch.png") });
        await page.getByTestId("terminal-options").tap();
        await expect(page.getByTestId("terminal-close-selected")).toBeVisible();
        await fitsViewport(page, page.getByRole("dialog"));
        await page.getByTestId("sheet-close").tap();
        await expect(page.getByTestId("terminal-options")).toBeFocused();
        await page.getByTestId("terminal-new").tap();
        const launcher = page.getByTestId("terminal-launch-menu");
        await expect(launcher.getByTestId("terminal-cwd")).toBeFocused();
        await fitsViewport(page, launcher);
        await launcher.getByRole("button", { name: "Close terminal launcher", exact: true }).tap();
        await expect(page.getByTestId("terminal-new")).toBeFocused();
      });
    });
  }
}

test.describe("active terminal on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("picker and close action identify the terminal displayed by a shared pane", async ({
    page,
    request,
  }) => {
    const first = await apiPost<{ id: string }>(request, "/terminals", {
      kind: "shell",
      name: "First mobile shell",
    });
    const second = await apiPost<{ id: string }>(request, "/terminals", {
      kind: "shell",
      name: "Second mobile shell",
    });
    await gotoView(page, "terminals");
    await page.goto(`/terminals/${first.id}?view=terminal&paneTerminal=${second.id}`);
    const picker = page.getByRole("combobox", { name: "Terminal", exact: true });
    await expect(picker).toHaveValue(second.id);
    await page.getByTestId("terminal-options").tap();
    await expect(page.getByTestId("terminal-close-selected")).toHaveAttribute(
      "aria-label",
      "Close Second mobile shell",
    );
    await page.getByTestId("sheet-close").tap();
    await picker.selectOption(first.id);
    await expect(page).toHaveURL(new RegExp(`paneTerminal=${first.id}`));
    await page.getByTestId("terminal-options").tap();
    await expect(page.getByTestId("terminal-close-selected")).toHaveAttribute(
      "aria-label",
      "Close First mobile shell",
    );
  });
});

test("desktop full-screen chat keeps its messages when returning to the panel", async ({
  page,
}) => {
  await gotoView(page, "tasks");
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill("Reply with exactly: FULLSCREEN-CONTINUITY.");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-message-content").last()).toContainText(
    "FULLSCREEN-CONTINUITY",
  );
  await page.getByTestId("chat-fullscreen-button").click();
  await expect(page.getByTestId("mobile-chat-sheet")).toBeVisible();
  await expect(page.getByTestId("mobile-chat-sheet")).toContainText("FULLSCREEN-CONTINUITY");
  await page.getByTestId("chat-fullscreen-button").click();
  await expect(page.getByTestId("mobile-chat-sheet")).toBeHidden();
  await expect(page.getByTestId("chat-panel")).toContainText("FULLSCREEN-CONTINUITY");
});

test("chat composer follows the visual viewport when a software keyboard opens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: viewport });
    Object.assign(window, {
      resizeKeyboardViewport: () => {
        Object.assign(viewport, { height: 410, offsetTop: 24 });
        viewport.dispatchEvent(new Event("resize"));
      },
    });
  });
  await gotoView(page, "tasks");
  await page.getByTestId("chat-open-button").click();
  await page.evaluate(() =>
    (window as unknown as { resizeKeyboardViewport: () => void }).resizeKeyboardViewport(),
  );
  await expect(page.getByTestId("mobile-chat-sheet")).toHaveCSS("height", "410px");
  await expect(page.getByTestId("mobile-chat-sheet")).toHaveCSS("top", "24px");
  const send = await page.getByTestId("chat-send-button").boundingBox();
  if (!send) throw new Error("Expected the composer send button to be visible");
  expect(send.y + send.height).toBeLessThanOrEqual(434);
});
