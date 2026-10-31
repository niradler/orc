import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSettingsSchema } from "@orc/core/chat";
import type { HumanRequest } from "@orc/core/human-requests";
import { expect, test } from "@playwright/test";
import {
  API_SECRET,
  apiGet,
  apiPost,
  gotoView,
  repoRoot,
  reviewAttentionRequest,
  tid,
} from "./_helpers";

test("should edit and run a masked command from Attention after reload", async ({
  page,
  request,
}) => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-pw-command-"));
  const entry = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "command",
    prompt: "Check service credentials",
    origin: { backend: "external", session_id: tid("command-session"), request_id: "command" },
    command: {
      host: null,
      cwd,
      script: 'printf "%s" "$ORC_INPUT_PASSWORD"',
      arguments: [{ name: "PASSWORD", label: "Service password" }],
    },
  });
  await gotoView(page, "attention");
  await page.reload();
  const card = page.getByTestId(`attention-request-${entry.id}`);
  await reviewAttentionRequest(card);
  const secret = "pw-secret-123";
  await card.getByTestId("attention-argument-PASSWORD").fill(secret);
  await expect(card.getByTestId("attention-argument-PASSWORD")).toHaveAttribute("type", "password");
  await card.getByTestId("attention-edit-command").click();
  await card
    .getByTestId("attention-command")
    .fill(
      process.platform === "win32"
        ? '[Console]::Out.Write("edited:" + $env:ORC_INPUT_PASSWORD)'
        : 'printf "edited:"; printf "%s" "$ORC_INPUT_PASSWORD"',
    );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `/tmp/orc-command-input-${width}.png`, fullPage: true });
  }
  await card.getByTestId("attention-run").click();
  await expect(card.getByTestId("attention-command-result")).toContainText("edited:[REDACTED]");
  await expect(card).not.toContainText(secret);
  const completed = await apiGet<HumanRequest>(request, `/human-requests/${entry.id}`);
  expect(completed.status).toBe("answered");
  expect(JSON.stringify(completed)).not.toContain(secret);
  await page.reload();
  await reviewAttentionRequest(card);
  await expect(card.getByTestId("attention-command-result")).toContainText("edited:[REDACTED]");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `/tmp/orc-command-attention-${width}.png`, fullPage: true });
  }
  const remote = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "command",
    prompt: "Command completed from another browser",
    origin: { backend: "external", session_id: tid("other-browser"), request_id: "command" },
    command: { host: null, cwd, script: "printf original" },
  });
  await page.reload();
  const remoteCard = page.getByTestId(`attention-request-${remote.id}`);
  await reviewAttentionRequest(remoteCard);
  await expect(remoteCard.getByTestId("attention-command-preview")).toHaveText("printf original");
  await apiPost(request, `/human-requests/${remote.id}/run`, {
    version: 1,
    script:
      process.platform === "win32"
        ? '[Console]::Out.Write("edited-elsewhere")'
        : "printf edited-elsewhere",
    values: {},
  });
  await expect(remoteCard.getByTestId("attention-command-result")).toContainText(
    "edited-elsewhere",
  );
  await expect(remoteCard.getByTestId("attention-command-preview")).toHaveText(
    process.platform === "win32"
      ? '[Console]::Out.Write("edited-elsewhere")'
      : "printf edited-elsewhere",
  );
});

test("should share recent folders and last selection between chat and terminal, and launch chat in a worktree", async ({
  page,
  request,
}) => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-pw-workspace-"));
  mkdirSync(join(cwd, "nested"));
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { timeout: 10000, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  git(["init"]);
  git([
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    "Seed",
  ]);
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto("/");
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-workspace-host").click();
  await page.getByTestId("chat-workspace-host-option").filter({ hasText: "Local" }).click();
  await page.getByTestId("chat-workspace-recent").click();
  await page.getByTestId("chat-workspace-cwd").fill(cwd);
  await page.getByTestId("chat-workspace-apply").click();
  // Exercise the native chooser contract without opening an OS dialog in CI.
  await page.route("**/api/terminals/pick-folder", (route) => {
    expect(route.request().postDataJSON()).toEqual({ initial: cwd, host: null });
    return route.fulfill({ json: { path: cwd } });
  });
  await page.getByTestId("chat-workspace-browse").click();
  await page.getByTestId("chat-workspace-recent").click();
  await expect(page.getByTestId("chat-workspace-recent-option")).toContainText([cwd]);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("chat-workspace-path")).toHaveAttribute("title", `Local: ${cwd}`);
  await gotoView(page, "terminals");
  await page.getByTestId("terminal-new").click();
  await page.getByTestId("terminal-host-select").selectOption("");
  await expect(page.getByTestId("terminal-cwd")).toHaveValue(cwd);
  await page.unroute("**/api/terminals/pick-folder");
  await page.getByTestId("terminal-browse").click();
  await page.getByTestId("remote-folder-name-nested").dblclick();
  await page.getByTestId("remote-folder-pick").click();
  await expect(page.getByTestId("terminal-cwd")).toHaveValue(join(cwd, "nested"));
  await page.reload();
  await page.getByTestId("terminal-new").click();
  await expect(page.getByTestId("terminal-cwd")).toHaveValue(join(cwd, "nested"));
  await page.screenshot({ path: "/tmp/orc-terminal-recent-folders.png", fullPage: true });
  await page.keyboard.press("Escape");
  const open = page.getByTestId("chat-open-button");
  if (await open.isVisible()) await open.click();
  await page.getByTestId("chat-workspace-recent").click();
  await page.getByTestId("chat-workspace-recent-option").filter({ hasText: cwd }).last().click();
  await page.getByTestId("chat-workspace-worktree").click();
  await expect(page.getByTestId("chat-workspace-worktree")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "/tmp/orc-chat-worktree.png", fullPage: true });
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat/stream") && response.request().method() === "POST",
  );
  await page.getByTestId("chat-input").fill("Reply workspace ready");
  await page.getByTestId("chat-input").press("Enter");
  expect((await response).status()).toBe(200);
  await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
  const url = new URL(page.url());
  const thread = await apiGet<{ cwd: string; host: string | null }>(
    request,
    `/chat/threads/${url.searchParams.get("chatThread")}`,
  );
  expect(thread.cwd.startsWith(join(cwd, ".orc", "worktrees"))).toBe(true);
  expect(thread.host).toBeNull();
  await page.reload();
  await expect(page.getByTestId("chat-workspace")).toHaveCount(0);
});

test("should collapse consecutive tools while retaining their input, results and separators", async ({
  page,
}) => {
  const id = crypto.randomUUID();
  const thread = {
    id,
    title: "Tool groups",
    config: ChatSettingsSchema.parse({}),
    cwd: "/tmp",
    host: null,
    runtimeId: null,
    backend: "codex-cli",
    sourceId: null,
    updatedAt: Date.now(),
    messages: [
      {
        id: "assistant",
        role: "assistant",
        content: "Finished",
        timestamp: Date.now(),
        activity: [
          { type: "tool", id: "one", name: "Read", input: "first input", result: "first result" },
          {
            type: "tool",
            id: "two",
            name: "Run",
            input: "second input",
            result: "second failure",
            isError: true,
          },
          { type: "status", id: "status", text: "Next step" },
          { type: "tool", id: "three", name: "Read", input: "third input", result: "third result" },
        ],
      },
    ],
  };
  const seed = spawnSync(
    "bun",
    [
      "-e",
      'import {getSqlite} from "./packages/db/src/client.ts";import {ChatStore} from "./packages/db/src/chat.ts";new ChatStore(getSqlite()).save(JSON.parse(process.argv[1]));',
      JSON.stringify(thread),
    ],
    { cwd: repoRoot(), env: process.env, encoding: "utf8", timeout: 10000 },
  );
  expect(seed.status, seed.stderr).toBe(0);
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/tasks?chat=open&chatThread=${id}`);
  const group = page.getByTestId("chat-tool-group");
  await expect(group).toHaveCount(1);
  await expect(group).not.toHaveAttribute("open", "");
  await expect(group.locator("summary").first()).toContainText("2 tool calls");
  await expect(group.locator("summary").first()).toContainText("1 failed");
  await group.locator("summary").first().click();
  await expect(group.getByTestId("chat-tool")).toHaveCount(2);
  await group.getByTestId("chat-tool").first().locator("summary").click();
  await expect(group.getByTestId("chat-tool").first()).toContainText("first input");
  await expect(group.getByTestId("chat-tool").first()).toContainText("first result");
  await expect(page.getByTestId("chat-tool").last()).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(group).toBeVisible();
    await page.screenshot({ path: `/tmp/orc-tool-group-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});
