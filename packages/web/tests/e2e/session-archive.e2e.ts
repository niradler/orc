import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArchiveSearchResult } from "@orc/core/session-archive";
import { expect, test } from "@playwright/test";
import {
  API_BASE,
  API_SECRET,
  AUTH_HEADERS,
  apiGet,
  apiPost,
  gotoView,
  repoRoot,
  tid,
} from "./_helpers";

const execute = promisify(execFile);
const nativeContent = (agent: "claude" | "codex", id: string, cwd: string, text: string) =>
  agent === "codex"
    ? `${JSON.stringify({ type: "session_meta", payload: { id, cwd, source: "cli" } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })}\n`
    : `${JSON.stringify({ type: "user", sessionId: id, cwd, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: "user", content: text } })}\n`;

test("HTTP MCP sync and script URLs retain the hosted TLS proxy origin", async ({ request }) => {
  const name = tid("archive-proxy");
  await apiPost(request, "/projects", { name });
  const headers = { ...AUTH_HEADERS, Host: "orc.example.com", "X-Forwarded-Proto": "https" };
  for (const [tool, args, key] of [
    ["session_sync", { projects: [name] }, "sync_url"],
    [
      "skill_read",
      { name: "orc-platform", project: name, ref: "scripts/sync-sessions.py", download: true },
      "download_url",
    ],
  ] as const) {
    const response = await request.post(`${API_BASE}/mcp/tool`, {
      headers,
      data: { name: tool, args },
    });
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { result: string };
    expect(new URL(JSON.parse(body.result)[key]).origin).toBe("https://orc.example.com");
  }
});

test("all Claude histories map across projects, preserve partial successes and skip duplicate files", async ({
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), "orc-all-claude-"));
  const one = tid("claude-one");
  const two = tid("claude-two");
  const p1 = await apiPost<{ id: string }>(request, "/projects", { name: one });
  const p2 = await apiPost<{ id: string }>(request, "/projects", { name: two });
  const oneId = randomUUID();
  const twoId = randomUUID();
  const oneText = nativeContent("claude", oneId, join(root, "project-a"), "first mapped project");
  writeFileSync(join(root, "one.jsonl"), oneText);
  writeFileSync(join(root, "one-copy.jsonl"), oneText);
  writeFileSync(
    join(root, "two.jsonl"),
    nativeContent("claude", twoId, join(root, "project-b"), "second mapped project"),
  );
  writeFileSync(
    join(root, "unmapped.jsonl"),
    nativeContent("claude", randomUUID(), join(root, "unknown"), "unmapped history"),
  );
  const map = join(root, "map.json");
  writeFileSync(
    map,
    JSON.stringify({ [join(root, "project-a")]: one, [join(root, "project-b")]: two }),
  );
  const args = [
    join(repoRoot(), "skills/orc-platform/scripts/sync-sessions.py"),
    "--url",
    API_BASE.replace(/\/api$/, ""),
    "--agent",
    "claude",
    "--root",
    root,
    "--project-map",
    map,
    "--source-id",
    one,
  ];
  const result = await execute("python", args, {
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, ORC_API_SECRET: API_SECRET },
  }).then(
    () => {
      throw new Error("Expected nonzero for unmapped history");
    },
    (error) => error as { stdout: string; stderr: string; code: number },
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("UNMAPPED");
  expect(
    (await apiGet<ArchiveSearchResult>(request, `/sessions/archive?project_id=${p1.id}`)).sessions,
  ).toHaveLength(1);
  expect(
    (await apiGet<ArchiveSearchResult>(request, `/sessions/archive?project_id=${p2.id}`)).sessions,
  ).toHaveLength(1);
  const retried = await execute("python", args, {
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, ORC_API_SECRET: API_SECRET },
  }).then(
    () => {
      throw new Error("Expected unmapped history");
    },
    (error) => error as { stdout: string },
  );
  expect(retried.stdout).toContain("manifest verified");
  expect(
    (await apiGet<ArchiveSearchResult>(request, `/sessions/archive?project_id=${p1.id}`)).sessions,
  ).toHaveLength(1);
});

test("offline project sync via trusted helper is idempotent, incremental and searchable after reload", async ({
  page,
  request,
}) => {
  const name = tid("archive-sync");
  const project = await apiPost<{ id: string }>(request, "/projects", { name });
  const root = mkdtempSync(join(tmpdir(), "orc-archive-browser-"));
  const downloaded = await apiPost<{ result: string }>(request, "/mcp/tool", {
    name: "skill_read",
    args: { name: "orc-platform", project: name, ref: "scripts/sync-sessions.py", download: true },
  });
  const download = JSON.parse(downloaded.result) as {
    download_url: string;
    sha256: string;
    size_bytes: number;
  };
  const bytesResponse = await request.get(download.download_url);
  expect(bytesResponse.ok()).toBe(true);
  const bytes = await bytesResponse.body();
  expect(bytes.length).toBe(download.size_bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(download.sha256);
  const script = join(root, "sync-sessions.py");
  writeFileSync(script, bytes);
  const grant = await apiPost<{ result: string }>(request, "/mcp/tool", {
    name: "session_sync",
    args: { projects: [name] },
  });
  const grantFile = join(root, "sync-grant.json");
  writeFileSync(grantFile, grant.result, { mode: 0o600 });
  expect(
    (await execute("python", [script, "--help"], { timeout: 10_000, windowsHide: true })).stdout,
  ).toContain("--project-map");
  const path = join(root, "native.jsonl");
  const id = randomUUID();
  const first = nativeContent("codex", id, root, "quartz butterfly migration");
  writeFileSync(path, first);
  const sync = () =>
    execute(
      "python",
      [
        script,
        "--grant-file",
        grantFile,
        "--project",
        name,
        "--agent",
        "codex",
        "--session-file",
        path,
        "--source-id",
        name,
      ],
      { timeout: 60_000, windowsHide: true, env: { ...process.env, ORC_API_SECRET: "" } },
    );
  expect((await sync()).stdout).toContain("CREATED");
  expect((await sync()).stdout).toContain("manifest verified");
  writeFileSync(
    path,
    first +
      `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "incremental canary saved" }] } })}\n`,
  );
  expect((await sync()).stdout).toContain("UPDATED");
  expect(readFileSync(path, "utf8")).toContain("incremental canary saved");
  await gotoView(page, "sessions");
  await page.goto(`/sessions?project=${project.id}`);
  await expect(page.getByTestId("show-ended")).toBeChecked();
  const row = page.getByTestId("archive-session-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("revision 2");
  await page.getByTestId("session-search").fill("quartz butterfly");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("quartz butterfly");
  await page.getByTestId("archive-disclosure").locator("summary").click();
  await row.click();
  await expect(page.getByTestId("archive-turn")).toContainText([
    "quartz butterfly",
    "incremental canary saved",
  ]);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("archive-session-row")).toHaveCount(1);
  await page.getByTestId("show-ended").click();
  await expect(page.getByTestId("show-ended")).not.toBeChecked();
  await expect(page.getByTestId("session-archive")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("show-ended")).not.toBeChecked();
  const listing = await apiGet<ArchiveSearchResult>(
    request,
    `/sessions/archive?project_id=${project.id}`,
  );
  expect(listing.sessions).toHaveLength(1);
  const searched = await apiPost<{ result: string }>(request, "/mcp/tool", {
    name: "session_search",
    args: { project: name, q: "quartz", limit: 1 },
  });
  const hits = JSON.parse(searched.result) as ArchiveSearchResult;
  expect(hits.sessions[0]?.id).toBe(listing.sessions[0]?.id);
  expect(hits.sessions[0]?.passages[0]?.citation).toContain("session:");
  const read = await apiPost<{ result: string }>(request, "/mcp/tool", {
    name: "session_read",
    args: { id: listing.sessions[0]?.id, revision: 1, ordinal: 0 },
  });
  expect(JSON.parse(read.result).text).toContain("quartz butterfly");
  expect((await apiGet<{ terminals: unknown[] }>(request, "/terminals")).terminals).toHaveLength(0);
});

test("browser upload requires a project and Settings persists the independent session toggle", async ({
  page,
  request,
}) => {
  const name = tid("archive-browser");
  const project = await apiPost<{ id: string }>(request, "/projects", { name });
  await gotoView(page, "sessions");
  await page.goto("/sessions?project=all");
  await page.getByTestId("archive-disclosure").locator("summary").click();
  await page.getByTestId("archive-upload-open").click();
  await expect(page.getByTestId("archive-files")).toBeDisabled();
  await page.getByTestId("archive-project").selectOption(project.id);
  await page.getByTestId("archive-files").setInputFiles({
    name: "claude-history.jsonl",
    mimeType: "application/json",
    buffer: Buffer.from(
      nativeContent("claude", randomUUID(), "/offline/project", "browser upload needle"),
    ),
  });
  await expect(page.getByTestId("archive-upload-feedback")).toContainText("1 of 1");
  await page.keyboard.press("Escape");
  await page.goto(`/sessions?project=${project.id}`);
  await expect(page.getByTestId("archive-session-row")).toHaveCount(1);
  await gotoView(page, "settings");
  const toggle = page.getByTestId("settings-session-embeddings");
  await toggle.check();
  await page.getByTestId("settings-knowledge-save").click();
  await expect
    .poll(
      async () =>
        (await apiGet<{ session_embeddings: boolean }>(request, "/kb/settings")).session_embeddings,
    )
    .toBe(true);
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.getByTestId("settings-knowledge-save").click();
  await expect
    .poll(
      async () =>
        (await apiGet<{ session_embeddings: boolean }>(request, "/kb/settings")).session_embeddings,
    )
    .toBe(false);
});

test("connected embedding HTTP provider enables semantic retrieval and failure visibly falls back", async ({
  page,
  request,
}) => {
  let unavailable = false;
  let queryCalls = 0;
  const provider = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()).input as string[];
    if (input.length === 1 && input[0] === "sunrise") queryCalls++;
    if (unavailable) {
      response.writeHead(503);
      response.end("fixture outage");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        data: input.map((text, index) => ({
          index,
          embedding: /plane|aircraft/i.test(text)
            ? [1, 0, 0, 0, 0, 0, 0, 0]
            : [0, 1, 0, 0, 0, 0, 0, 0],
        })),
      }),
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Provider fixture port missing");
  const patch = async (body: unknown) => {
    const res = await request.patch(`${API_BASE}/kb/settings`, {
      headers: AUTH_HEADERS,
      data: body,
    });
    expect(res.ok()).toBe(true);
  };
  try {
    const name = tid("semantic-session");
    const project = await apiPost<{ id: string }>(request, "/projects", { name });
    const nativeId = randomUUID();
    const accepted = await apiPost<{ session: { id: string } }>(
      request,
      "/sessions/archive/upload",
      {
        project: name,
        source_id: name,
        agent: "codex",
        session_id: nativeId,
        title: "Flight notes",
        metadata: { cwd: "/offline/repo" },
        bundle: {
          version: 1,
          files: [
            {
              path: "session.jsonl",
              content: nativeContent(
                "codex",
                nativeId,
                "/offline/repo",
                "The plane departs at sunrise",
              ),
            },
          ],
        },
      },
    );
    await patch({
      session_embeddings: true,
      embedding: {
        provider: "openai",
        base_url: `http://127.0.0.1:${address.port}/v1`,
        model: "isolated-archive-fixture",
        dimensions: 8,
      },
    });
    await expect
      .poll(async () => {
        const result = await apiGet<ArchiveSearchResult>(
          request,
          `/sessions/archive?q=aircraft&project_id=${project.id}`,
        );
        return (
          result.mode === "hybrid" &&
          result.sessions[0]?.id === accepted.session.id &&
          result.pending_chunks === 0
        );
      })
      .toBe(true);
    unavailable = true;
    await gotoView(page, "sessions");
    await page.goto(`/sessions?project=${project.id}&q=sunrise`);
    await expect(page.getByTestId("archive-degraded")).toContainText("keyword");
    await expect(page.getByTestId("archive-session-row")).toContainText("sunrise");
    await patch({ session_embeddings: false });
    const count = queryCalls;
    const fallback = await apiGet<ArchiveSearchResult>(
      request,
      `/sessions/archive?q=sunrise&project_id=${project.id}`,
    );
    expect(fallback.mode).toBe("lexical");
    expect(fallback.sessions[0]?.id).toBe(accepted.session.id);
    expect(queryCalls).toBe(count);
  } finally {
    await patch({
      session_embeddings: false,
      embedding: { provider: "none", base_url: null, model: null, dimensions: null },
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

for (const agent of ["claude", "codex"] as const) {
  test(`archived ${agent} history prepares a native session and opens the pinned terminal`, async ({
    page,
    request,
  }) => {
    const availability = await apiGet<{ ready: boolean; launchers: string[] }>(
      request,
      "/terminals",
    );
    test.skip(
      !availability.ready || !availability.launchers.includes(agent),
      `${agent} CLI and PTY required`,
    );
    const git = async (...args: string[]) =>
      (await execute("git", args, { timeout: 30_000, windowsHide: true })).stdout.trim();
    const root = mkdtempSync(join(tmpdir(), "orc-archive-resume-"));
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    const target = join(root, "target");
    await git("init", "--bare", remote);
    await git("init", source);
    const subdirectory = agent === "codex" ? "packages/app" : "";
    const sourceCwd = join(source, subdirectory);
    mkdirSync(sourceCwd, { recursive: true });
    writeFileSync(join(source, "work.txt"), "archived work\n");
    writeFileSync(join(sourceCwd, "context.txt"), "session cwd marker\n");
    await git("-C", source, "add", "work.txt", ".");
    await git(
      "-C",
      source,
      "-c",
      "user.name=ORC Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Archive fixture",
    );
    const commit = await git("-C", source, "rev-parse", "HEAD");
    await git("-C", source, "remote", "add", "origin", remote);
    await git("-C", source, "push", "origin", "HEAD:refs/heads/archive/test");
    await git("clone", "--branch", "archive/test", remote, target);
    const name = tid(`archive-resume-${agent}`);
    const project = await apiPost<{ id: string }>(request, "/projects", { name, scope: target });
    const nativeId = randomUUID();
    const accepted = await apiPost<{ session: { id: string } }>(
      request,
      "/sessions/archive/upload",
      {
        project: name,
        source_id: name,
        agent,
        session_id: nativeId,
        title: `Continue ${agent} archived work`,
        metadata: {
          cwd: sourceCwd,
          repository: remote,
          branch: "archive/test",
          commit,
          subdirectory,
        },
        bundle: {
          version: 1,
          files: [
            {
              path: "session.jsonl",
              content: nativeContent(agent, nativeId, sourceCwd, "Continue archived work"),
            },
          ],
        },
      },
    );
    await gotoView(page, "sessions");
    await page.goto(`/sessions?project=${project.id}`);
    await page.getByTestId("archive-disclosure").locator("summary").click();
    await page
      .locator(`[data-testid="archive-session-row"][data-archive-id="${accepted.session.id}"]`)
      .click();
    await page.getByTestId("archive-resume").click();
    await page.waitForURL(/\/terminals\/[^/]+$/);
    const terminalId = new URL(page.url()).pathname.split("/").at(-1);
    const terminal = await apiGet<{
      cwd: string;
      kind: string;
      live_session_id: string;
      status: string;
      pid: number | null;
    }>(request, `/terminals/${terminalId}`);
    expect(terminal.kind).toBe(agent);
    expect(terminal.status).toBe("running");
    expect(terminal.pid).toBeGreaterThan(0);
    expect(await git("-C", terminal.cwd, "rev-parse", "HEAD")).toBe(commit);
    expect(terminal.cwd.replace(/\\/g, "/")).toContain("/.orc/worktrees/");
    if (subdirectory)
      expect(terminal.cwd.replace(/\\/g, "/").endsWith(`/${subdirectory}`)).toBe(true);
    const archive = await apiGet<{
      revisions: unknown[];
      handoffs: { revision: number; handoff_id: string }[];
    }>(request, `/sessions/archive/${accepted.session.id}`);
    expect(archive.revisions).toHaveLength(1);
    expect(archive.handoffs).toHaveLength(1);
    expect(archive.handoffs[0]?.revision).toBe(1);
    const stopped = await request.delete(`${API_BASE}/terminals/${terminalId}`, {
      headers: AUTH_HEADERS,
    });
    expect(stopped.status()).toBe(204);
  });
}
