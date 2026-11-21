import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionHandoff, SessionHandoffUpload } from "@orc/core/session-handoff";
import { expect, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiGet, apiPost, gotoView, tid } from "./_helpers";

const execute = promisify(execFile);
const ownedSessions = new Set<string>();

test.afterEach(async ({ request }) => {
  const listing = await apiGet<{ terminals: { id: string; live_session_id: string | null }[] }>(
    request,
    "/terminals",
  );
  for (const terminal of listing.terminals) {
    if (!terminal.live_session_id || !ownedSessions.has(terminal.live_session_id)) continue;
    const stopped = await request.delete(`${API_BASE}/terminals/${terminal.id}`, {
      headers: AUTH_HEADERS,
    });
    expect(stopped.status()).toBe(204);
  }
  ownedSessions.clear();
});

async function git(...args: string[]): Promise<string> {
  const result = await execute("git", args, { timeout: 30_000, windowsHide: true });
  return result.stdout.trim();
}

for (const agent of ["claude", "codex"] as const) {
  test(`should upload ${agent} history, show Ready and continue in chat`, async ({
    page,
    request,
  }) => {
    const availability = await apiGet<{ ready: boolean; launchers: string[] }>(
      request,
      "/terminals",
    );
    test.skip(
      !availability.ready || !availability.launchers.includes(agent),
      `${agent} CLI and PTY support are required`,
    );
    // The resume runs in chat, so its agent CLI outlives this spec and holds the
    // worktree cwd. The run harness owns this home and removes it after the API
    // and its children exit (same pattern as session-archive's resume home).
    const root = mkdtempSync(join(homedir(), "orc-browser-handoff-"));
    const source = join(root, "source");
    const target = join(root, "target");
    const remote = join(root, "remote.git");
    await git("init", "--bare", remote);
    await git("init", source);
    writeFileSync(join(source, "work.txt"), "Browser handoff state\n");
    await git("-C", source, "add", "work.txt");
    await git(
      "-C",
      source,
      "-c",
      "user.name=ORC Browser Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Handoff state",
    );
    const commit = await git("-C", source, "rev-parse", "HEAD");
    await git("-C", source, "remote", "add", "origin", remote);
    await git("-C", source, "push", "origin", "HEAD:refs/heads/handoff/browser");
    await git("clone", "--branch", "handoff/browser", remote, target);
    const project = tid(`pw-handoff-${agent}`);
    await apiPost(request, "/projects", { name: project, scope: target });
    const sourceId = randomUUID();
    const timestamp = new Date().toISOString();
    const messageId = randomUUID();
    const rows =
      agent === "claude"
        ? [
            {
              type: "user",
              sessionId: sourceId,
              cwd: source,
              uuid: messageId,
              parentUuid: null,
              isSidechain: false,
              timestamp,
              message: { role: "user", content: "Continue browser handoff validation" },
            },
            {
              type: "assistant",
              sessionId: sourceId,
              cwd: source,
              uuid: randomUUID(),
              parentUuid: messageId,
              isSidechain: false,
              timestamp,
              message: {
                id: "msg_handoff",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "Ready to continue" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          ]
        : [
            {
              timestamp,
              type: "session_meta",
              payload: {
                id: sourceId,
                cwd: source,
                timestamp,
                source: "cli",
                originator: "codex_cli_rs",
                cli_version: "0.100.0",
                model_provider: "openai",
              },
            },
            {
              timestamp,
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Continue browser handoff validation" }],
              },
            },
          ];
    const handoff = await apiPost<SessionHandoffUpload>(request, "/session-handoffs", {
      project,
      agent,
      session_id: sourceId,
      source_cwd: source,
      repository: remote,
      branch: "handoff/browser",
      commit,
      title: project,
    });
    const response = await request.put(handoff.upload_url, {
      data: {
        version: 1,
        files: [
          {
            path: "session.jsonl",
            content: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
          },
        ],
      },
    });
    expect(response.ok()).toBe(true);
    const ready = (await response.json()) as SessionHandoff;
    if (ready.live_session_id) ownedSessions.add(ready.live_session_id);
    expect(ready.status).toBe("ready");
    expect(await git("-C", ready.cwd as string, "rev-parse", "HEAD")).toBe(commit);
    expect(ready.cwd?.replace(/\\/g, "/").endsWith(`/.orc/worktrees/${ready.id}`)).toBe(true);
    await gotoView(page, "sessions");
    const row = page.locator(
      `[data-testid="chat-history-row"][data-history-id="native:${ready.live_session_id}"]`,
    );
    await expect(row).toBeVisible();
    await expect(row.getByTestId("handoff-ready")).toHaveText("Ready to resume");
    await row.getByTestId("chat-resume-live").click();
    await expect(page.getByTestId("chat-panel").filter({ visible: true })).toBeVisible();
    await expect
      .poll(
        async () => (await apiGet<SessionHandoff>(request, `/session-handoffs/${ready.id}`)).status,
      )
      .toBe("resumed");
  });
}
