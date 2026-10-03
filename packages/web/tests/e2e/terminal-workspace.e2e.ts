import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { API_SECRET, apiGet, apiPost } from "./_helpers";

test("multiplexer splits terminal, Git and file panes, resizes and restores them without stopping shells", async ({
  page,
  request,
}) => {
  const repo = mkdtempSync(join(tmpdir(), "orc-panes-"));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "test"],
  ])
    execFileSync("git", ["-C", repo, ...args], { timeout: 15_000, windowsHide: true });
  writeFileSync(join(repo, "hello.txt"), "workspace preview\n");
  execFileSync("git", ["-C", repo, "add", "."], { timeout: 15_000 });
  execFileSync("git", ["-C", repo, "commit", "-m", "init"], { timeout: 15_000 });
  const first = await apiPost<{ id: string }>(request, "/terminals", { kind: "shell", cwd: repo });
  const second = await apiPost<{ id: string }>(request, "/terminals", { kind: "shell", cwd: repo });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((secret) => localStorage.setItem("orc_api_secret", secret), API_SECRET);
  await page.goto(`/terminals/${first.id}`);
  await expect(page.getByTestId("terminal-viewport")).toHaveCount(1);
  await page.getByTestId("pane-split-horizontal").click();
  await expect(page.getByTestId("workspace-pane")).toHaveCount(2);
  const git = page
    .getByTestId("workspace-pane")
    .filter({ has: page.getByTestId("terminal-git-panel") });
  await expect(git).toContainText("main");
  const divider = page.getByTestId("workspace-resize");
  const before = await page.getByTestId("workspace-pane").first().boundingBox();
  const rect = await divider.boundingBox();
  if (!before || !rect) throw new Error("Missing split geometry");
  await page.mouse.move(rect.x + 3, rect.y + 50);
  await page.mouse.down();
  await page.mouse.move(rect.x + 90, rect.y + 50, { steps: 6 });
  await page.mouse.up();
  expect((await page.getByTestId("workspace-pane").first().boundingBox())?.width).toBeGreaterThan(
    before.width + 50,
  );
  await git.getByTestId("pane-split-vertical").click();
  await expect(page.getByTestId("workspace-pane")).toHaveCount(3);
  const files = page.getByTestId("workspace-pane").filter({ has: page.getByTestId("file-panel") });
  await files.getByTestId("file-entry").filter({ hasText: "hello.txt" }).click();
  await expect(files.getByTestId("file-preview")).toContainText("workspace preview");
  await files.getByTestId("pane-view").selectOption("terminal");
  await page
    .getByTestId("workspace-pane")
    .filter({ has: page.getByTestId("terminal-viewport") })
    .nth(1)
    .getByTestId("pane-terminal")
    .selectOption(second.id);
  await expect(page.getByTestId("terminal-viewport")).toHaveCount(2);
  await expect(files).toHaveCount(0);
  const terminals = page
    .getByTestId("workspace-pane")
    .filter({ has: page.getByTestId("terminal-viewport") });
  await expect(terminals.nth(1).getByTestId("pane-terminal")).toHaveValue(second.id);
  await terminals.nth(1).getByTestId("pane-view").selectOption("files");
  await page.reload();
  await expect(page.getByTestId("workspace-pane")).toHaveCount(3);
  await expect(page.getByTestId("file-panel")).toBeVisible();
  await page.getByTestId("workspace-resize").first().focus();
  const saved = Number(
    await page.getByTestId("workspace-resize").first().getAttribute("aria-valuenow"),
  );
  await page.getByTestId("workspace-resize").first().press("ArrowLeft");
  await expect(page.getByTestId("workspace-resize").first()).toHaveAttribute(
    "aria-valuenow",
    String(saved - 5),
  );
  await page
    .getByTestId("workspace-pane")
    .filter({ has: page.getByTestId("file-panel") })
    .getByTestId("pane-close")
    .click();
  await expect(page.getByTestId("workspace-pane")).toHaveCount(2);
  const info = await apiGet<{ terminals: { id: string; status: string }[] }>(request, "/terminals");
  expect(info.terminals.find((terminal) => terminal.id === second.id)?.status).toBe("running");
  await page.getByTestId("chat-open-button").click();
  const chat = page.getByTestId("chat-panel");
  const width = (await chat.boundingBox())?.width ?? 0;
  await page.getByTestId("chat-panel-resize").focus();
  await page.getByTestId("chat-panel-resize").press("ArrowLeft");
  expect((await chat.boundingBox())?.width).toBe(width + 16);
  expect(errors).toEqual([]);
});
