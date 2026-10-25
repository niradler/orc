import { expect } from "@playwright/test";
import { apiPost, gotoView } from "./_helpers";
import { test } from "./_terminal-fixture";

test("select all copies the whole buffer, scrollback included, not just the oldest screen", async ({
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
  await page.locator("textarea[aria-label='Terminal input']").first().focus();
  const win = process.platform === "win32";
  await page.keyboard.type(
    win
      ? '1..200 | ForEach-Object { "PROBE_$_" }'
      : "for i in $(seq 1 200); do echo PROBE_$i; done",
  );
  // A shell still starting up can drop typeahead, so wait for the echo before running it.
  await expect.poll(() => output).toContain(win ? "ForEach-Object" : "seq 1 200");
  await page.keyboard.press("Enter");
  await expect.poll(() => output).toContain("PROBE_200");

  const mac = process.platform === "darwin";
  await page.keyboard.press(mac ? "Meta+KeyA" : "Control+Shift+KeyA");
  await page.keyboard.press(mac ? "Meta+KeyC" : "Control+Shift+KeyC");
  // The first and last rows prove the copy spans scrollback and the visible screen.
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^PROBE_1\r?$[\s\S]*^PROBE_200\r?$/m);
});
