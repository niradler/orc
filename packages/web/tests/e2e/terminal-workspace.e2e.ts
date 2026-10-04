import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  mkdirSync(join(repo, "src", "nested"), { recursive: true });
  writeFileSync(join(repo, "src", "nested", "example.ts"), "export const example = 42;\n");
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
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
  const rootFolder = files.getByTestId("files-root");
  await expect(rootFolder).toHaveAttribute("aria-expanded", "true");
  await rootFolder.click();
  await expect(files.getByTestId("file-entry")).toHaveCount(0);
  await rootFolder.focus();
  await rootFolder.press("ArrowRight");
  await expect(rootFolder).toHaveAttribute("aria-expanded", "true");
  const sourceFolder = files.getByTestId("file-entry").filter({ hasText: /^src$/ });
  await expect(sourceFolder).toHaveAttribute("aria-expanded", "false");
  await sourceFolder.click();
  await expect(sourceFolder).toHaveAttribute("aria-expanded", "true");
  await files
    .getByTestId("file-entry")
    .filter({ hasText: /^nested$/ })
    .click();
  const example = files.getByTestId("file-entry").filter({ hasText: /^example.ts$/ });
  await example.click();
  await expect(files.getByTestId("file-preview")).toContainText("example = 42");
  await expect(files.getByTestId("file-editor-input")).toBeVisible();
  await expect(example).toHaveAttribute("aria-current", "true");
  await example.focus();
  await example.press("ArrowLeft");
  await expect(files.getByTestId("file-entry").filter({ hasText: /^nested$/ })).toBeFocused();
  await expect(files.getByTestId("file-entry").filter({ hasText: /^hello.txt$/ })).toBeVisible();
  await files.screenshot({ path: "../../output/playwright/files-tree.png" });
  await page.setViewportSize({ width: 2400, height: 1000 });
  const treeBounds = await files.getByTestId("files-tree").boundingBox();
  const previewBounds = await files.getByTestId("file-preview").boundingBox();
  if (!treeBounds || !previewBounds) throw new Error("Missing file explorer geometry");
  expect(previewBounds.x).toBeGreaterThanOrEqual(treeBounds.x + treeBounds.width);
  await files.screenshot({ path: "../../output/playwright/files-tree-wide.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await files.getByTestId("files-refresh").click();
  await expect(example).toBeVisible();
  await sourceFolder.click();
  await expect(example).toHaveCount(0);
  await expect(files.getByTestId("file-preview")).toContainText("example = 42");
  await sourceFolder.click();
  await expect(example).toBeVisible();
  await files.getByTestId("files-collapse").click();
  await expect(example).toHaveCount(0);
  await files
    .getByTestId("file-entry")
    .filter({ hasText: /^binary.bin$/ })
    .click();
  await expect(files).toContainText("Binary file; text preview unavailable.");
  await files.getByTestId("file-preview-close").click();
  await expect(files.getByTestId("file-preview-close")).toHaveCount(0);
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

test("should edit, save and reopen text files while preserving drafts and rejecting disk conflicts", async ({
  page,
  request,
}) => {
  const repo = mkdtempSync(join(tmpdir(), "orc-editor-"));
  execFileSync("git", ["-C", repo, "init", "-b", "main"], { timeout: 15_000, windowsHide: true });
  writeFileSync(join(repo, "example.ts"), "export const answer = 42;\r\n");
  writeFileSync(join(repo, "other.txt"), "another file\n");
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
  });
  await page.addInitScript((secret) => localStorage.setItem("orc_api_secret", secret), API_SECRET);
  await page.goto(`/terminals/${terminal.id}`);
  await page.getByTestId("pane-view").selectOption("files");
  await page
    .getByTestId("file-entry")
    .filter({ hasText: /^example.ts$/ })
    .click();
  const input = page.getByTestId("file-editor-input");
  await expect(input).toBeVisible();
  await input.click();
  await input.press("ControlOrMeta+a");
  await page.keyboard.insertText("export const answer = 7;\n");
  await expect(page.getByTestId("file-save-status")).toHaveText("Unsaved changes");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByTestId("file-entry")
    .filter({ hasText: /^other.txt$/ })
    .click();
  await expect(input).toContainText("answer = 7");
  await page.getByTestId("pane-view").selectOption("git");
  await page.getByTestId("pane-view").selectOption("files");
  await page
    .getByTestId("file-entry")
    .filter({ hasText: /^example.ts$/ })
    .click();
  await expect(input).toContainText("answer = 7");
  await expect(page.getByTestId("file-save-status")).toHaveText("Unsaved changes");
  await input.press("ControlOrMeta+s");
  await expect(page.getByTestId("file-save-status")).toHaveText("Saved");
  const readFile = async () =>
    await apiGet<{ content: string }>(request, `/terminals/${terminal.id}/files?path=example.ts`);
  expect((await readFile()).content).toBe("export const answer = 7;\r\n");
  await page.reload();
  await page
    .getByTestId("file-entry")
    .filter({ hasText: /^example.ts$/ })
    .click();
  await expect(input).toContainText("answer = 7");
  await page.getByRole("button", { name: "Word wrap", exact: true }).click();
  await expect(page.getByRole("button", { name: "Word wrap", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Find in file", exact: true }).click();
  await expect(page.locator(".cm-search")).toBeVisible();
  await input.click();
  await input.press("ControlOrMeta+a");
  await page.keyboard.insertText("export const answer = 8;\n");
  writeFileSync(join(repo, "example.ts"), "export const answer = 99;\r\n");
  await page.getByTestId("file-save").click();
  await expect(page.getByRole("alert")).toContainText("File changed on disk");
  expect((await readFile()).content).toBe("export const answer = 99;\r\n");
  await expect(input).toContainText("answer = 8");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("file-reload").click();
  await expect(input).toContainText("answer = 99");
  await expect(page.getByTestId("file-save-status")).toHaveText("Saved");
  await page.screenshot({ path: "../../output/playwright/file-editor-save-reopen.png" });
});
