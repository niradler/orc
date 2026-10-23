import { expect } from "@playwright/test";
import { API_SECRET, apiGet, apiPost } from "./_helpers";
import { test } from "./_terminal-fixture";

for (const width of [1440, 390]) {
  test(`should rename terminal and preserve session after reload at ${width}px`, async ({
    page,
    request,
  }) => {
    const terminal = await apiPost<{ id: string; pid: number; name: string }>(
      request,
      "/terminals",
      { kind: "shell" },
    );
    await page.addInitScript((secret) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    }, API_SECRET);
    await page.setViewportSize({ width, height: 900 });
    let sockets = 0;
    page.on("websocket", (socket) => {
      if (socket.url().includes(`/terminals/${terminal.id}/ws`)) sockets++;
    });
    await page.goto(`/terminals/${terminal.id}?project=all`);
    await expect(page.getByTestId("terminal-viewport")).toBeVisible();
    await expect.poll(() => sockets).toBe(1);
    await page.getByTestId("terminal-actions").click();
    await page.getByTestId("terminal-rename").click();
    await page.getByTestId("terminal-rename-input").fill("Cancelled name");
    await page.getByTestId("terminal-rename-cancel").click();
    await expect(page.getByTestId("terminal-name")).toHaveText(terminal.name);
    await page.getByTestId("terminal-actions").click();
    await page.getByTestId("terminal-rename").click();
    await page.getByTestId("terminal-rename-input").fill("   ");
    await expect(page.getByTestId("terminal-rename-save")).toBeDisabled();
    await page.getByTestId("terminal-rename-input").fill("  API debugging ✨  ");
    await page.getByTestId("terminal-rename-save").click();
    await expect(page.getByTestId("terminal-name")).toHaveText("API debugging ✨");
    await expect(page.getByTestId("pane-terminal")).toHaveAttribute(
      "title",
      "Find terminal: API debugging ✨",
    );
    if (width === 1440)
      await expect(
        page.getByTestId("terminal-item").filter({ hasText: "API debugging ✨" }),
      ).toBeVisible();
    expect(sockets).toBe(1);
    await page.reload();
    await expect(page.getByTestId("terminal-name")).toHaveText("API debugging ✨");
    const updated = await apiGet<{ pid: number; status: string }>(
      request,
      `/terminals/${terminal.id}`,
    );
    expect(updated.pid).toBe(terminal.pid);
    expect(updated.status).toBe("running");
    await page.getByTestId("terminal-actions").click();
    await page.getByTestId("terminal-rename").click();
    await page.route(`**/api/terminals/${terminal.id}`, async (route) => {
      if (route.request().method() === "PATCH")
        return route.fulfill({ status: 500, json: { error: "Rename failed" } });
      return route.continue();
    });
    await page.getByTestId("terminal-rename-input").fill("Retry this name");
    await page.getByTestId("terminal-rename-save").click();
    await expect(page.getByTestId("terminal-rename-error")).toBeVisible();
    await expect(page.getByTestId("terminal-rename-input")).toHaveValue("Retry this name");
    await page.getByTestId("terminal-rename-cancel").click();
    await expect(page.getByTestId("terminal-name")).toHaveText("API debugging ✨");
  });
}

test("should offer tab context actions, duplicate a fresh process and remember worktree selection", async ({
  page,
  request,
}) => {
  const terminal = await apiPost<{ id: string; pid: number; cwd: string; kind: string }>(
    request,
    "/terminals",
    { kind: "shell", name: "Context actions" },
  );
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await page.getByTestId("terminal-item").locator("a").click({ button: "right" });
  await expect(page.getByTestId("terminal-actions-menu")).toBeVisible();
  await page.getByTestId("terminal-duplicate").click();
  await expect(page.getByTestId("terminal-name")).toHaveText("Context actions (copy)");
  const list = await apiGet<{
    terminals: { id: string; pid: number; cwd: string; kind: string; status: string }[];
  }>(request, "/terminals");
  const duplicate = list.terminals.find((item) => item.id !== terminal.id);
  expect(duplicate?.pid).not.toBe(terminal.pid);
  expect(duplicate?.cwd).toBe(terminal.cwd);
  expect(duplicate?.kind).toBe(terminal.kind);
  expect(list.terminals.find((item) => item.id === terminal.id)?.status).toBe("running");
  await page.getByTestId("pane-terminal").click();
  await page.getByTestId("command-palette-input").fill("no matching session");
  await expect(page.getByTestId("palette-status")).toContainText("No matching terminals");
  await page.getByTestId("command-palette-input").fill("Context");
  await expect(page.locator('[data-command-id^="terminal-"]')).toHaveCount(2);
  await page.getByTestId("command-palette-input").press("Escape");
  await page.getByTestId("terminal-new").click();
  await page.getByTestId("terminal-worktree").check();
  await page.getByTestId("terminal-worktree").press("Escape");
  await page.reload();
  await page.getByTestId("terminal-new").click();
  await expect(page.getByTestId("terminal-worktree")).toBeChecked();
  await page.getByTestId("terminal-worktree").uncheck();
  await page.getByTestId("terminal-worktree").press("Escape");
  await page.reload();
  await page.getByTestId("terminal-new").click();
  await expect(page.getByTestId("terminal-worktree")).not.toBeChecked();
});
