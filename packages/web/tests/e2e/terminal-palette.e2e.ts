import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { API_SECRET, apiGet, apiPost, splitTerminalPane } from "./_helpers";
import { test } from "./_terminal-fixture";

for (const width of [1440, 390]) {
  test(`should find and focus existing terminals from the shared palette at ${width}px`, async ({
    page,
    request,
  }) => {
    const terminalKeys: boolean[] = [];
    page.on("websocket", (socket) => {
      if (socket.url().includes("/terminals/"))
        socket.on("framesent", ({ payload }) => {
          terminalKeys.push(
            typeof payload === "string" ? payload.includes("\u000b") : payload.includes(11),
          );
        });
    });
    const cwd = mkdtempSync(join(tmpdir(), "orc-palette-review-"));
    const first = await apiPost<{ id: string; pid: number }>(request, "/terminals", {
      kind: "shell",
      cwd,
      name: "API debugging",
    });
    const second = await apiPost<{ id: string; pid: number }>(request, "/terminals", {
      kind: "shell",
      cwd,
      name: "Build checks",
    });
    await page.addInitScript(
      (secret) =>
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
      API_SECRET,
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/terminals/${first.id}?project=all`);
    await expect(page.getByTestId("terminal-viewport")).toBeVisible();
    await expect(page.getByTestId("terminal-search")).toHaveCount(0);
    const picker = page.getByTestId("pane-terminal");
    await picker.click();
    const input = page.getByTestId("command-palette-input");
    await expect(page.getByTestId("palette-filter-terminals")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(input).toBeFocused();
    const results = page.locator('[data-command-id^="terminal-"]');
    await expect(results).toHaveCount(2);
    await expect(results.first()).toContainText("API debugging");
    await input.fill("local shell");
    await expect(results).toHaveCount(2);
    await input.fill("orc-palette-review");
    await expect(results).toHaveCount(2);
    await input.fill("missing-terminal");
    await expect(page.getByTestId("palette-status")).toContainText("No matching terminals");
    await input.fill("build checks");
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText("Local");
    await expect(results.first()).toContainText("Running");
    const accessibility = await new AxeBuilder({ page })
      .include('[data-testid="command-palette"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({ path: `../../output/playwright/terminal-palette-${width}.png` });
    await input.press("Escape");
    await expect(picker).toBeFocused();
    await picker.click();
    await input.fill("build");
    await input.press("Enter");
    await expect(picker).toHaveAttribute("data-terminal-id", second.id);
    await expect(page.getByTestId("terminal-viewport")).toHaveCount(1);
    await expect(page.getByTestId("command-palette")).toHaveCount(0);
    await expect(page.getByTestId("terminal-viewport").locator("textarea")).toBeFocused();
    const info = await apiGet<{ terminals: { id: string; pid: number; status: string }[] }>(
      request,
      "/terminals",
    );
    expect(info.terminals).toHaveLength(2);
    expect(info.terminals.find((item) => item.id === first.id)).toMatchObject({
      pid: first.pid,
      status: "running",
    });
    expect(info.terminals.find((item) => item.id === second.id)).toMatchObject({
      pid: second.pid,
      status: "running",
    });
    await page.getByTestId("terminal-viewport").locator("textarea").focus();
    await page.keyboard.press("Control+k");
    await expect(input).toBeVisible();
    expect(terminalKeys.some(Boolean)).toBe(false);
    await page.getByTestId("palette-filter-terminals").click();
    await input.fill("API debugging");
    await input.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/terminals/${first.id}\\?`));
    await expect(picker).toHaveAttribute("data-terminal-id", first.id);
    if (width === 1440) {
      await splitTerminalPane(page.getByTestId("workspace-pane").first(), "horizontal");
      const other = page.getByTestId("workspace-pane").last();
      await other.getByTestId("pane-view-terminal").click();
      await expect(page.getByTestId("terminal-viewport")).toHaveCount(2);
      await other.getByTestId("pane-terminal").click();
      await input.fill("API debugging");
      await input.press("Enter");
      await expect(page.getByTestId("workspace-pane").first()).toHaveAttribute(
        "data-active",
        "true",
      );
      await expect(page.getByTestId("workspace-pane").first().locator("textarea")).toBeFocused();
      await expect(page.getByTestId("terminal-viewport")).toHaveCount(2);
    }
  });
}
