import { expect } from "@playwright/test";
import { isMacPlatform } from "../../src/lib/terminal-keys";
import { apiPost, gotoView } from "./_helpers";
import { test } from "./_terminal-fixture";

test("terminal output reaches the screen while the tab is hidden and frames are paused", async ({
  context,
  page,
  request,
}) => {
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  let output = "";
  page.on("websocket", (socket) => {
    if (!socket.url().includes(`/terminals/${terminal.id}/ws`)) return;
    socket.on("framereceived", ({ payload }) => {
      output += payload.toString();
    });
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoView(page, "terminals");
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await expect(page.locator("[data-testid='terminal-surface'] canvas").first()).toBeVisible();
  await expect.poll(() => output.length).toBeGreaterThan(0);
  const input = page.locator("textarea[aria-label='Terminal input']").first();
  await input.focus();

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    window.requestAnimationFrame = () => 0;
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const win = process.platform === "win32";
  await page.keyboard.type(win ? '"HIDDEN_" + "MARK"' : "echo HIDDEN_''MARK");
  await expect.poll(() => output).toContain(win ? '"MARK"' : "''MARK");
  await page.keyboard.press("Enter");
  await expect.poll(() => output).toContain("HIDDEN_MARK");

  const mac = await page.evaluate(isMacPlatform);
  await input.focus();
  await page.keyboard.press(mac ? "Meta+KeyA" : "Control+Shift+KeyA");
  await page.keyboard.press(mac ? "Meta+KeyC" : "Control+Shift+KeyC");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^HIDDEN_MARK\r?$/m);
});
