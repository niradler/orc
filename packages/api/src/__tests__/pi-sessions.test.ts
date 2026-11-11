import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeChatAgent } from "@orc/core/chat";
import { loadConfig } from "@orc/core/config";
import { hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { parsePiSession, piAdapter, piSessionRoots } from "../sessions/pi.js";
import { readTranscriptBytes } from "../sessions/transcript.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

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
