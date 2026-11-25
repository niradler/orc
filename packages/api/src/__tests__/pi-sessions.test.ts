import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeChatAgent } from "@orc/core/chat";
import { loadConfig } from "@orc/core/config";
import { hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { writeRegistration } from "@orc/core/live-session";
import { getSqlite } from "@orc/db/client";
import { runSync } from "../session-watcher.js";
import { withLifecycle } from "../sessions/lifecycle.js";
import { parsePiSession, piAdapter, piSessionRoots } from "../sessions/pi.js";
import { readTranscriptBytes } from "../sessions/transcript.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const nativeId = "33583f12-72b3-4edf-a18d-8616b7d10723";
const timestamp = "2026-11-11T08:00:00.000Z";
const header = { type: "session", version: 3, id: nativeId, timestamp, cwd: "C:/work/demo" };
function entry(id: string, parentId: string | null, extra: Record<string, unknown>) {
  return { id, parentId, timestamp, ...extra };
}
function log(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

test("should import native Pi identity, name, usage and transcript while isolating corrupt files", async () => {
  const root = mkdtempSync(join(tmpdir(), "orc-pi-import-"));
  const project = join(root, "--C-work-demo--");
  mkdirSync(project);
  try {
    const file = join(project, `2026-11-11_${nativeId}.jsonl`);
    writeFileSync(
      file,
      `${log([
        header,
        entry("u", null, {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Continue my Pi work" },
              { type: "image", data: "private image bytes" },
            ],
          },
        }),
        entry("a", "u", {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Consider the fix" },
              { type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } },
            ],
            usage: { totalTokens: 123 },
          },
        }),
        entry("t", "a", {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call",
            content: [{ type: "text", text: "Read result" }],
          },
        }),
        entry("n", "t", { type: "session_info", name: "Named Pi session" }),
      ])}\n{"incomplete":`,
    );
    writeFileSync(join(project, "invalid.jsonl"), log([{ ...header, id: "../../bad" }]));
    const sessions = await piAdapter(root).list(new Map());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      backend: "pi",
      externalId: nativeId,
      title: "Named Pi session",
      cwd: header.cwd,
      status: "stopped",
      tokensUsed: 123,
      transcriptPath: file,
    });
    expect(nativeChatAgent("pi")).toBe("pi");
    const transcript = await readTranscriptBytes(await Bun.file(file).bytes(), "pi", file);
    expect(transcript.turns).toHaveLength(2);
    expect(transcript.turns[1]?.blocks).toContainEqual({
      type: "tool_use",
      id: "call",
      name: "read",
      input: '{"path":"README.md"}',
      result: "Read result",
    });
    expect(JSON.stringify(transcript)).toContain("[Image]");
    expect(JSON.stringify(transcript)).not.toContain("private image bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("should display the resumed branch and apply context edits without leaking other branches", async () => {
  const content = log([
    header,
    entry("u", null, { type: "message", message: { role: "user", content: "Original user" } }),
    entry("discarded", "u", {
      type: "message",
      message: { role: "assistant", content: "Abandoned branch" },
    }),
    entry("chosen", "u", {
      type: "message",
      message: { role: "assistant", content: "Chosen reply" },
    }),
    entry("edit", "chosen", {
      type: "context_edit",
      targetId: "u",
      replacement: { content: "Edited user" },
    }),
  ]);
  const transcript = await readTranscriptBytes(
    new TextEncoder().encode(content),
    "pi",
    "pi-branch",
  );
  expect(transcript.turns.map((turn) => turn.blocks)).toEqual([
    [{ type: "text", text: "Edited user" }],
    [{ type: "text", text: "Chosen reply" }],
  ]);
  expect(parsePiSession(log([{ ...header, version: 99 }]))).toBeNull();
  expect(
    parsePiSession(log([header, entry("cycle", "cycle", { type: "custom" })]))?.branch,
  ).toHaveLength(1);
});

test("should discover configured Pi roots without reading secret environment values", async () => {
  setupTestApp();
  const home = join(tmpdir(), "validation-home");
  const custom = join(tmpdir(), "custom-pi");
  const runtime = { ...hostRuntime(LOCAL_HOST), home: async () => home };
  try {
    loadConfig().providers = {
      default_id: "pi",
      instances: [
        {
          id: "pi",
          name: "Pi",
          agent: "pi",
          enabled: true,
          executable: "",
          model: "",
          environment: [
            { name: "PI_CODING_AGENT_DIR", value: custom, secret: false },
            { name: "PI_CODING_AGENT_DIR", value: "encrypted-must-not-be-a-path", secret: true },
          ],
        },
      ],
    };
    const roots = await piSessionRoots(runtime);
    expect(roots).toContain(join(custom, "sessions"));
    expect(roots.join(" ")).not.toContain("encrypted-must-not-be-a-path");
    expect(roots).toContain(join(home, ".pi", "agent", "sessions"));
  } finally {
    teardownTestApp();
  }
});

test("a Pi transcript with no message is not an openable session and drops its empty row", async () => {
  const root = mkdtempSync(join(tmpdir(), "orc-pi-empty-"));
  const namedId = "8f2f0f9f-9d1a-4e26-9a0c-1a6f9c5e2b77";
  const namedHeader = { ...header, id: namedId };
  try {
    // Pi creates the file at launch and writes its header with the first turn.
    const launchFile = join(root, `2026-11-11_${nativeId}.jsonl`);
    writeFileSync(launchFile, "");
    const headerOnly = join(root, `2026-11-11_${namedId}.jsonl`);
    writeFileSync(headerOnly, `${log([namedHeader])}\n`);
    const known = new Map(
      [
        {
          id: nativeId,
          path: launchFile,
          title: "Pi session",
        },
        {
          id: namedId,
          path: headerOnly,
          title: "New session",
        },
      ].map(({ id, path, title }) => [
        id,
        {
          lastActivityMs: Date.parse(timestamp),
          tokensUsed: null,
          session: {
            backend: "pi",
            externalId: id,
            title,
            summary: null,
            status: "stopped" as const,
            createdAt: new Date(timestamp),
            lastActivityAt: new Date(timestamp),
            transcriptPath: path,
          },
        },
      ]),
    );
    expect(await piAdapter(root).list(known)).toMatchObject([
      { externalId: nativeId, transcriptPath: null },
      { externalId: namedId, transcriptPath: null },
    ]);
    expect(await piAdapter(root).list(new Map())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty copy in a second Pi root does not hide the session listed from the first", async () => {
  setupTestApp();
  const base = mkdtempSync(join(tmpdir(), "orc-pi-roots-"));
  const home = join(base, "home");
  const defaultRoot = join(home, ".pi", "agent", "sessions");
  const configuredRoot = join(base, "custom", "sessions");
  mkdirSync(defaultRoot, { recursive: true });
  mkdirSync(configuredRoot, { recursive: true });
  try {
    loadConfig().providers = {
      default_id: "pi",
      instances: [
        {
          id: "pi",
          name: "Pi",
          agent: "pi",
          enabled: true,
          executable: "",
          model: "",
          environment: [
            { name: "PI_CODING_AGENT_DIR", value: join(base, "custom"), secret: false },
          ],
        },
      ],
    };
    const runtime = { ...hostRuntime(LOCAL_HOST), home: async () => home };
    const known = (transcriptPath: string) =>
      new Map([
        [
          nativeId,
          {
            lastActivityMs: Date.parse(timestamp),
            tokensUsed: null,
            session: {
              backend: "pi",
              externalId: nativeId,
              title: "Pi session",
              summary: null,
              status: "stopped" as const,
              createdAt: new Date(timestamp),
              lastActivityAt: new Date(timestamp),
              transcriptPath,
            },
          },
        ],
      ]);
    // Whichever root holds the conversation, the empty launch file in the other one must
    // not replace the readable path: the stored row points at one of them, and the sync
    // keeps the last record it sees for that session id.
    for (const contentRoot of [defaultRoot, configuredRoot]) {
      const otherRoot = contentRoot === defaultRoot ? configuredRoot : defaultRoot;
      const good = join(contentRoot, `2026-11-11_${nativeId}.jsonl`);
      const stale = join(otherRoot, `2026-11-11_${nativeId}.jsonl`);
      writeFileSync(
        good,
        `${log([
          header,
          entry("u", null, { type: "message", message: { role: "user", content: "Hello Pi" } }),
        ])}\n`,
      );
      writeFileSync(stale, "");
      const sessions = await piAdapter(undefined, runtime).list(known(stale));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ externalId: nativeId, transcriptPath: good });
      rmSync(good);
      rmSync(stale);
    }
  } finally {
    teardownTestApp();
    rmSync(base, { recursive: true, force: true });
  }
});

test("a Pi launched without a prompt leaves no ORC session in the list", async () => {
  const app = setupTestApp();
  const root = mkdtempSync(join(tmpdir(), "orc-pi-list-"));
  const registry = join(root, "live");
  const sessionHeader = { ...header, cwd: root };
  try {
    const file = join(root, `2026-11-11_${nativeId}.jsonl`);
    writeFileSync(file, "");
    // The row an earlier porc left when it registered a Pi that never prompted.
    getSqlite()
      .prepare(
        "INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, title, status, transcript_path, created_at, last_activity_at) VALUES ('empty-pi-row', '__live-sessions__', 'pi', 'direct', ?, 'Pi session', 'stopped', ?, unixepoch(), unixepoch())",
      )
      .run(nativeId, file);
    writeRegistration(
      {
        backend: "pi",
        externalId: nativeId,
        pid: process.pid,
        title: "Pi session",
        transcriptPath: file,
        status: "stopped",
        createdAt: Date.parse(timestamp),
        updatedAt: Date.parse(timestamp),
      },
      registry,
    );
    const adapter = withLifecycle(piAdapter(root), registry);
    await runSync([adapter], { force: true });
    expect(
      (await (await req(app, "GET", "/sessions/live?agent=pi&active=false")).json()).sessions,
    ).toEqual([]);
    writeFileSync(
      file,
      `${log([
        sessionHeader,
        entry("u", null, { type: "message", message: { role: "user", content: "Hello Pi" } }),
      ])}\n`,
    );
    await runSync([adapter], { force: true });
    expect(
      (await (await req(app, "GET", "/sessions/live?agent=pi&active=false")).json()).sessions,
    ).toMatchObject([{ session_id: nativeId, summary: "Hello Pi" }]);
  } finally {
    teardownTestApp();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live Pi registration marks its transcript session running with the writer pid", async () => {
  const root = mkdtempSync(join(tmpdir(), "orc-pi-live-"));
  const registry = join(root, "live");
  try {
    writeFileSync(
      join(root, `2026-11-11_${nativeId}.jsonl`),
      `${log([
        header,
        entry("u", null, { type: "message", message: { role: "user", content: "Hello Pi" } }),
      ])}\n`,
    );
    const live = {
      backend: "pi",
      externalId: nativeId,
      pid: process.pid,
      title: "Pi session",
      status: "running" as const,
      createdAt: Date.parse(timestamp),
      updatedAt: Date.now(),
    };
    writeRegistration(live, registry);
    const adapter = withLifecycle(piAdapter(root), registry);
    expect(await adapter.list(new Map())).toMatchObject([
      { externalId: nativeId, status: "running", pid: process.pid, cwd: header.cwd },
    ]);
    writeRegistration({ ...live, pid: 2_000_000_000 }, registry);
    expect(await adapter.list(new Map())).toMatchObject([
      { externalId: nativeId, status: "stopped" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
