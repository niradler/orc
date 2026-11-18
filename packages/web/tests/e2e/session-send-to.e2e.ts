import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { API_PORT, apiDelete, apiGet, apiPost, gotoView, repoRoot, tid } from "./_helpers";

const execute = promisify(execFile);
const git = (...args: string[]) =>
  execute("git", args, { timeout: 30_000, windowsHide: true }).then((result) =>
    result.stdout.trim(),
  );

/** The real bun executable; Playwright workers run under Node, so resolve it from PATH. */
function bunBinary(): string {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const found = execFileSync(lookup, ["bun"], { encoding: "utf8", windowsHide: true })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const exe = found.find((line) => line.endsWith("bun.exe")) ?? found[0];
  if (!exe) throw new Error("bun is not on PATH");
  return exe;
}

interface Fixture {
  root: string;
  source: string;
  liveId: string;
  nativeId: string;
  destUrl: string;
  destProject: string;
  stop: () => Promise<void>;
}

/** A native Claude session on the source server, a second ORC installation, and a shared bare remote. */
async function setup(request: APIRequestContext): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "orc-pw-send-to-"));
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const target = join(root, "target");
  await git("init", "--bare", remote);
  await git("init", source);
  writeFileSync(join(source, ".gitattributes"), "* -text\n");
  writeFileSync(join(source, "work.txt"), "send-to e2e state\n");
  await git("-C", source, "add", ".gitattributes", "work.txt");
  await git(
    "-C",
    source,
    "-c",
    "user.name=ORC Browser Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Send-to state",
  );
  await git("-C", source, "remote", "add", "origin", remote);
  await git("-C", source, "push", "origin", "HEAD:refs/heads/main");
  await git("clone", "--branch", "main", remote, target);

  // The shard owns HOME/CLAUDE_CONFIG_DIR, so a transcript written here is
  // discovered by the source watcher without touching a real agent home.
  const nativeId = randomUUID();
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(root, "claude");
  const key = source.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(claudeDir, "projects", key);
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  const messageId = randomUUID();
  const rows = [
    {
      type: "user",
      sessionId: nativeId,
      cwd: source,
      uuid: messageId,
      parentUuid: null,
      isSidechain: false,
      timestamp,
      message: { role: "user", content: "Continue the send-to e2e work" },
    },
    {
      type: "assistant",
      sessionId: nativeId,
      cwd: source,
      uuid: randomUUID(),
      parentUuid: messageId,
      isSidechain: false,
      timestamp,
      message: {
        id: "msg_send_e2e",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Ready to continue on another host" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  writeFileSync(
    join(dir, `${nativeId}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  // The watcher creates sessions from registry entries; a live pid keeps this
  // fixture idle (the normal state for sending a session onward).
  const registryDir = join(claudeDir, "sessions");
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(
    join(registryDir, `${nativeId}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: nativeId,
      cwd: source,
      name: "Send-to e2e",
      status: "idle",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await apiPost(request, "/sessions/live/sync", {});
  const listing = await apiGet<{ sessions: { id: string; session_id: string | null }[] }>(
    request,
    "/sessions/live?agent=claude&limit=500",
  );
  const live = listing.sessions.find((session) => session.session_id === nativeId);
  if (!live) throw new Error("The source watcher did not discover the fixture session");

  const destHome = join(root, "dest-home");
  mkdirSync(destHome, { recursive: true });
  const destination = spawn(
    bunBinary(),
    [join(repoRoot(), "packages/api/src/__tests__/fixtures/send-destination.ts")],
    {
      env: {
        ...process.env,
        ORC_HOME: destHome,
        ORC_DB_PATH: join(destHome, "orc.db"),
        ORC_API_HOST: "127.0.0.1",
        ORC_API_PORT: "0",
        ORC_API_SECRET: "dest-secret",
        ORC_ACTIVE_PROJECT: "",
        ORC_E2E_CHAT_MOCK: "1",
        CLAUDE_CONFIG_DIR: join(root, "dest-claude"),
        // The browser lists projects cross-origin; the host must allow this dashboard.
        ORC_API_CORS_ORIGINS: `http://127.0.0.1:${API_PORT}`,
      },
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    },
  );
  const stop = () =>
    new Promise<void>((resolve) => {
      destination.once("exit", () => resolve());
      // A PATH shim may wrap the real server; kill the whole tree on Windows.
      if (process.platform === "win32" && destination.pid) {
        try {
          execFileSync("taskkill", ["/PID", String(destination.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          destination.kill();
        }
      } else destination.kill("SIGKILL");
    });
  let port = 0;
  let buffer = "";
  while (!port) {
    const chunk = await new Promise<Buffer | null>((resolve) => {
      destination.stdout.once("data", (data: Buffer) => resolve(data));
      destination.once("exit", () => resolve(null));
    });
    if (!chunk) throw new Error("The destination ORC exited before reporting its port");
    buffer += chunk.toString("utf8");
    const match = buffer.match(/PORT=(\d+)/);
    if (match) port = Number(match[1]);
  }
  const destUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const health = await fetch(`${destUrl}/api/health`, { headers: { Connection: "close" } });
      if (health.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("The destination ORC did not become healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const destProject = tid("pw-send-dest");
  const created = await fetch(`${destUrl}/api/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer dest-secret",
      Connection: "close",
    },
    body: JSON.stringify({ name: destProject, scope: target }),
  });
  if (created.status !== 201)
    throw new Error(`Destination project creation failed: ${created.status}`);
  return { root, source, liveId: live.id, nativeId, destUrl, destProject, stop };
}

async function teardown(fixture: Fixture): Promise<void> {
  await fixture.stop();
  // A shim's exit does not mean the whole tree released its files; wait until
  // the server stops answering before removing its home.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${fixture.destUrl}/api/health`, {
        headers: { Connection: "close" },
        signal: AbortSignal.timeout(1_000),
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch {
      break;
    }
  }
  // Windows releases child file handles asynchronously; match the shard cleanup budget.
  rmSync(fixture.root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
}

async function saveHost(request: APIRequestContext, fixture: Fixture): Promise<string> {
  const { hosts } = await apiPost<{ hosts: { id: string }[] }>(request, "/remote-hosts", {
    label: "Send box",
    url: fixture.destUrl,
    token: "dest-secret",
  });
  const id = hosts.at(-1)?.id;
  if (!id) throw new Error("The remote host was not saved");
  return id;
}

test("Send to host moves the session and the destination continues it", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const fixture = await setup(request);
  const hostId = await saveHost(request, fixture);
  try {
    await gotoView(page, "activity");
    const row = page.locator(`[data-session-id="${fixture.liveId}"]`).locator("..");
    await expect(row).toBeVisible();
    await row.getByTestId("resume-actions-menu").click();
    await page.getByTestId("send-to-host").click();
    await expect(page.getByTestId("send-to-host-dialog")).toBeVisible();
    await page.getByTestId(`send-to-host-${hostId}`).click();
    const select = page.getByTestId("send-to-project-select");
    await expect(select).toBeVisible();
    await expect(select).toHaveValue(fixture.destProject);
    await page.getByTestId("send-to-note").fill("finish the e2e");
    await page.getByTestId("send-to-submit").click();
    await expect(page.getByTestId("send-to-result")).toContainText("Sent to Send box", {
      timeout: 60_000,
    });
    const open = page.getByTestId("send-to-open");
    await expect(open).toHaveAttribute("href", /sessionLive=/);
    const href = await open.getAttribute("href");
    const remoteId = new URL(href ?? "", "http://localhost").searchParams.get("sessionLive");
    expect(remoteId).toBeTruthy();

    // The destination really holds the conversation and can continue it.
    const resumed = await fetch(`${fixture.destUrl}/api/chat/threads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dest-secret",
        Connection: "close",
      },
      body: JSON.stringify({ sourceSessionId: remoteId }),
    });
    expect(resumed.status).toBe(200);
    const thread = (await resumed.json()) as {
      id: string;
      importedMessages?: number;
      handoffBriefing?: string;
    };
    expect(thread.importedMessages ?? 0).toBeGreaterThanOrEqual(2);
    expect(thread.handoffBriefing).toContain("finish the e2e");
    const turn = await fetch(`${fixture.destUrl}/api/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dest-secret",
        Connection: "close",
      },
      body: JSON.stringify({
        threadId: thread.id,
        messages: [{ role: "user", content: "Reply with exactly: E2E-CONTINUED." }],
      }),
    });
    expect(turn.status).toBe(200);
    expect(await turn.text()).toContain("E2E-CONTINUED");

    // The source keeps a badge pointing at the host that now owns the work.
    await page.getByRole("button", { name: "Done" }).click();
    await page.reload();
    await expect(page.getByTestId("session-sent-badge").first()).toContainText("Sent to Send box");
  } finally {
    await apiDelete(request, `/remote-hosts/${hostId}`).catch(() => {});
    await teardown(fixture);
  }
});

test.describe("phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("Send to host dialog works on a phone", async ({ page, request }) => {
    test.setTimeout(120_000);
    const fixture = await setup(request);
    const hostId = await saveHost(request, fixture);
    try {
      await gotoView(page, "activity");
      const row = page.locator(`[data-session-id="${fixture.liveId}"]`).locator("..");
      await expect(row).toBeVisible();
      await row.getByTestId("resume-actions-menu").tap();
      await page.getByTestId("send-to-host").tap();
      await expect(page.getByTestId("send-to-host-dialog")).toBeVisible();
      await page.getByTestId(`send-to-host-${hostId}`).tap();
      await expect(page.getByTestId("send-to-project-select")).toBeVisible();
      await expect(page.getByTestId("send-to-submit")).toBeVisible();
      await page.getByTestId("send-to-submit").tap();
      await expect(page.getByTestId("send-to-result")).toContainText("Sent to Send box", {
        timeout: 60_000,
      });
      await expect(page.getByTestId("send-to-open")).toBeVisible();
    } finally {
      await apiDelete(request, `/remote-hosts/${hostId}`).catch(() => {});
      await teardown(fixture);
    }
  });
});
