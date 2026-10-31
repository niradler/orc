import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { API_SECRET, apiGet, apiPost, splitTerminalPane } from "./_helpers";
import { test } from "./_terminal-fixture";

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390, 320]) {
    test(`terminal page preserves splits, shares files and keeps shell alive ${theme}/${width}`, async ({
      page,
      request,
      browser,
    }, testInfo) => {
      const repo = mkdtempSync(join(tmpdir(), "orc-redesign-terminal-"));
      execFileSync("git", ["-C", repo, "init", "-b", "main"], {
        timeout: 15000,
        windowsHide: true,
      });
      mkdirSync(join(repo, "nested"));
      writeFileSync(join(repo, "nested", "guide.md"), "# Shared guide\nOriginal content.\n");
      const terminal = await apiPost<{ id: string }>(request, "/terminals", {
        kind: "shell",
        cwd: repo,
      });
      await page.request.patch("/api/settings", {
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
      let sockets = 0;
      page.on("websocket", (socket) => {
        if (socket.url().includes(`/terminals/${terminal.id}/ws`)) sockets++;
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/terminals/${terminal.id}?project=all&sentinel=keep`);
      await expect(page.getByTestId("terminal-viewport")).toBeVisible();
      await expect.poll(() => sockets).toBe(1);
      await splitTerminalPane(page.getByTestId("workspace-pane").first(), "horizontal");
      const git = page
        .getByTestId("workspace-pane")
        .filter({ has: page.getByTestId("terminal-git-panel") });
      await expect(git).toContainText("main");
      await splitTerminalPane(git, "vertical");
      const files = page
        .getByTestId("workspace-pane")
        .filter({ has: page.getByTestId("file-panel") });
      await files
        .getByTestId("file-entry")
        .filter({ hasText: /^nested$/ })
        .click();
      await files
        .getByTestId("file-entry")
        .filter({ hasText: /^guide.md$/ })
        .click();
      await expect(page).toHaveURL(/file=nested%2Fguide.md/);
      await files.getByTestId("markdown-mode-edit").click();
      await files
        .getByTestId("file-editor-input")
        .fill("# Shared guide\nSaved from redesign validation.\n");
      if (width < 768)
        // Switching mobile panes remounts the editor; make it do so before the post-save refetch.
        await page.route(/\/files\?.*guide\.md/, async (route) => {
          if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 1500));
          return route.continue();
        });
      await files.getByTestId("file-save").click();
      await expect(files.getByTestId("file-save-status")).toHaveText("Saved");
      expect(readFileSync(join(repo, "nested", "guide.md"), "utf8")).toContain(
        "Saved from redesign validation",
      );
      await files.getByTestId("markdown-mode-read").click();
      const shared = page.url();
      expect(new URL(shared).searchParams.get("project")).toBe("all");
      expect(new URL(shared).searchParams.get("sentinel")).toBe("keep");
      await page.setViewportSize({ width, height: 900 });
      if (width < 768) {
        await expect(page.getByTestId("mobile-workspace-pane")).toHaveCount(3);
        await expect(page.getByTestId("workspace-pane").filter({ visible: true })).toHaveCount(1);
        await page
          .getByTestId("mobile-workspace-pane")
          .filter({ hasText: /^Terminal/ })
          .click();
        await expect(page.getByTestId("terminal-viewport")).toBeVisible();
        await page
          .getByTestId("mobile-workspace-pane")
          .filter({ hasText: /^Files/ })
          .click();
        await expect(files.getByTestId("markdown-preview")).toContainText(
          "Saved from redesign validation",
        );
        await page.goBack();
        await expect(page.getByTestId("terminal-viewport")).toBeVisible();
        await page.goForward();
        await expect(files.getByTestId("markdown-preview")).toContainText(
          "Saved from redesign validation",
        );
        expect(sockets).toBe(1);
      }
      if (width < 768) {
        expect((await files.getByTestId("markdown-preview").boundingBox())?.height).toBeGreaterThan(
          180,
        );
        await files.getByTestId("files-browser-toggle").click();
        await expect(files.getByTestId("files-tree")).toBeVisible();
        await files.getByTestId("files-browser-toggle").click();
        await expect(files.getByTestId("files-tree")).toBeHidden();
      }
      await page.screenshot({ path: testInfo.outputPath(`terminals-${theme}-${width}-files.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByTestId("workspace-pane")).toHaveCount(3);
      const snapshot = await page.evaluate(() => localStorage.getItem("orc_workspace_layout"));
      await page.getByTestId("theme-toggle").click();
      expect(await page.evaluate(() => localStorage.getItem("orc_workspace_layout"))).toBe(
        snapshot,
      );
      expect(sockets).toBe(1);
      // A new profile can open the shared URL without the local pane IDs or layout.
      const before = await apiGet<{ terminals: { id: string; status: string }[] }>(
        request,
        "/terminals",
      );
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const other = await context.newPage();
      await other.addInitScript(
        ({ secret, theme }) => {
          localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
          localStorage.setItem("orc_theme", theme);
        },
        { secret: API_SECRET, theme },
      );
      await other.goto(shared);
      await expect(other.getByTestId("pane-view")).toHaveAttribute("data-view", "files");
      await expect(other.getByTestId("markdown-mode-read")).toHaveAttribute("aria-pressed", "true");
      await expect(other.getByTestId("markdown-preview")).toContainText(
        "Saved from redesign validation",
      );
      await other.getByTestId("pane-view-git").click();
      await expect(other).toHaveURL(/view=git/);
      await other.goBack();
      await expect(other.getByTestId("pane-view")).toHaveAttribute("data-view", "files");
      await expect(other.getByTestId("markdown-preview")).toContainText(
        "Saved from redesign validation",
      );
      const after = await apiGet<{ terminals: { id: string; status: string }[] }>(
        request,
        "/terminals",
      );
      expect(after.terminals.length).toBe(before.terminals.length);
      expect(after.terminals.find((entry) => entry.id === terminal.id)?.status).toBe("running");
      await other.goto(
        shared.replace(`paneTerminal=${terminal.id}`, "paneTerminal=unavailable-terminal"),
      );
      await expect(other.getByTestId("workspace-pane")).toContainText(
        "unavailable or has been closed",
      );
      await context.close();
    });
  }
}

for (const theme of ["dark", "light"] as const) {
  test(`terminal loading, empty, launch keyboard and error states ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.request.patch("/api/settings", {
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
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fail = false;
    await page.route(/\/api\/terminals(?:\?.*)?$/, async (route) => {
      await gate;
      if (fail)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Cannot load terminal list" }),
        });
      else
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ready: true,
            reason: null,
            host: null,
            launchers: ["shell"],
            terminals: [],
            max: 8,
          }),
        });
    });
    await page.goto("/terminals");
    await expect(page.getByTestId("terminal-loading")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`terminal-${theme}-loading.png`) });
    release();
    await expect(page.getByText("No terminals yet", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`terminal-${theme}-empty.png`) });
    await page.getByTestId("terminal-new").click();
    await expect(page.getByTestId("terminal-cwd")).toBeFocused();
    await expect(page.getByTestId("terminal-launch-menu")).toBeVisible();
    await page.getByTestId("terminal-cwd").press("Escape");
    await expect(page.getByTestId("terminal-launch-menu")).toHaveCount(0);
    await expect(page.getByTestId("terminal-new")).toBeFocused();
    fail = true;
    await page.reload();
    await expect(page.getByTestId("terminal-load-error")).toContainText(
      "Cannot load terminal list",
    );
    await page.screenshot({ path: testInfo.outputPath(`terminal-${theme}-error.png`) });
  });
}

test("first pane transition restores its default on Back and terminal actions retain global URL context", async ({
  page,
  request,
}) => {
  const repo = mkdtempSync(join(tmpdir(), "orc-terminal-history-"));
  execFileSync("git", ["-C", repo, "init", "-b", "main"], { timeout: 15000, windowsHide: true });
  const project = await apiPost<{ id: string }>(request, "/projects", {
    name: `terminal-scope-${Date.now()}`,
  });
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
  });
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    localStorage.setItem("orc_selected_project", "all");
  }, API_SECRET);
  await page.goto(`/terminals/${terminal.id}?project=${project.id}&chat=open`);
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "terminal");
  await page.getByTestId("pane-view-files").click();
  await expect(page).toHaveURL(/view=files/);
  await page.goBack();
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "terminal");
  await page.goForward();
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "files");
  await page.getByTestId("terminal-new").click();
  await page.getByTestId("terminal-cwd").fill(repo);
  await page.getByTestId("terminal-launch-shell").click();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe(`/terminals/${terminal.id}`);
  expect(new URL(page.url()).searchParams.get("project")).toBe(project.id);
  expect(new URL(page.url()).searchParams.get("chat")).toBe("open");
  const createdId = new URL(page.url()).pathname.split("/").pop();
  await page
    .getByTestId("terminal-item")
    .filter({ has: page.locator(`a[href*="/terminals/${createdId}"]`) })
    .getByRole("button")
    .click();
  await page.getByTestId("terminal-close-selected").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe(`/terminals/${createdId}`);
  expect(new URL(page.url()).searchParams.get("project")).toBe(project.id);
  expect(new URL(page.url()).searchParams.get("chat")).toBe("open");
  expect(await page.evaluate(() => localStorage.getItem("orc_selected_project"))).toBe("all");
});
