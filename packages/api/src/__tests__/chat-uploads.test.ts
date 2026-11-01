import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentBackend,
  type AgentSession,
  createBackend,
  registerBackend,
} from "@orc/agent-runtime";
import type { ChatEvent, ChatThread } from "@orc/core/chat";
import { getSqlite } from "@orc/db/client";
import { setupTestApp, teardownTestApp } from "./helpers";

const home = mkdtempSync(join(tmpdir(), "orc-upload-api-"));
const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
let app: ReturnType<typeof setupTestApp>;
let original: AgentBackend;
let prompt = "";
const auth = { Authorization: "Bearer test-secret" };
const fixture: AgentSession = {
  id: "upload-fixture",
  alive: () => true,
  close: async () => {},
  respondPermission: () => {},
  send: async (value) => {
    prompt = value;
  },
  async *events() {
    yield { type: "text", data: "File received" };
    yield { type: "result", data: { runtimeSessionId: "upload-native" } };
  },
};
beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  app = setupTestApp();
  original = createBackend("codex-cli");
  registerBackend("codex-cli", () => ({
    name: "codex-cli",
    preflight: async () => ({ ok: true }),
    startSession: async () => fixture,
    resumeSession: async () => fixture,
    stop: async () => {},
  }));
});
afterAll(() => {
  registerBackend("codex-cli", () => original);
  teardownTestApp();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalProfile;
  rmSync(home, { recursive: true, force: true });
});
function form(threadId?: string, projectId?: string): FormData {
  const data = new FormData();
  data.set(
    "payload",
    JSON.stringify({
      agent: "codex",
      messages: [{ role: "user", content: "Read these files" }],
      ...(threadId
        ? { threadId }
        : {
            workspace: { host: null, cwd: home, worktree: false },
            ...(projectId ? { projectId } : {}),
          }),
    }),
  );
  data.append(
    "files",
    new File([new Uint8Array([0, 255, 1, 10])], "report.bin", { type: "application/octet-stream" }),
  );
  return data;
}
async function upload(data: FormData): Promise<{ response: Response; thread: ChatThread }> {
  const response = await app.request("/api/chat/uploads", {
    method: "POST",
    headers: auth,
    body: data,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Upload failed ${response.status}: ${text}`);
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as ChatEvent);
  const event = events.find((entry) => entry.type === "thread");
  if (event?.type !== "thread") throw new Error("Missing upload conversation");
  return { response, thread: event.thread };
}
test("should save multiple binary files, pass host paths to the agent and persist attachments for follow-ups", async () => {
  const data = form();
  data.append("files", new File(["second version"], "report.bin"));
  const { thread } = await upload(data);
  const files = thread.messages[0]?.attachments ?? [];
  expect(files).toHaveLength(2);
  expect(files[0]?.path).not.toBe(files[1]?.path);
  expect(new Uint8Array(readFileSync(files[0]?.path ?? ""))).toEqual(
    new Uint8Array([0, 255, 1, 10]),
  );
  const manifest = prompt
    .split("\n")
    .filter((line) => line.startsWith('{"name":'))
    .map((line) => JSON.parse(line) as { path: string });
  expect(manifest[0]?.path).toBe(files[0]?.path);
  const saved = await app.request(`/api/chat/threads/${thread.id}`, { headers: auth });
  expect(((await saved.json()) as ChatThread).messages[0]?.attachments).toEqual(files);
  const next = await upload(form(thread.id));
  expect(next.thread.messages.filter((message) => message.attachments?.length)).toHaveLength(2);
});
test("should honor a saved project upload directory", async () => {
  getSqlite()
    .query(
      "INSERT INTO projects(id,name,scope,upload_directory) VALUES ('upload-project','upload-project',?,'custom-files')",
    )
    .run(home);
  const { thread } = await upload(form(undefined, "upload-project"));
  expect(thread.messages[0]?.attachments?.[0]?.path).toContain(
    join(home, "custom-files", thread.id),
  );
  getSqlite().query("UPDATE projects SET status='archived' WHERE id='upload-project'").run();
  const follow = await app.request("/api/chat/stream", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: thread.id,
      messages: [{ role: "user", content: "Continue reading the saved file" }],
    }),
  });
  expect(follow.status).toBe(200);
  await follow.text();
  expect(
    (
      await app.request("/api/chat/uploads", {
        method: "POST",
        headers: auth,
        body: form(thread.id),
      })
    ).status,
  ).toBe(400);
});
test("should reject unauthenticated, malformed and oversized attachments", async () => {
  expect((await app.request("/api/chat/uploads", { method: "POST", body: form() })).status).toBe(
    401,
  );
  const invalid = form();
  invalid.set("payload", "{}");
  expect(
    (await app.request("/api/chat/uploads", { method: "POST", headers: auth, body: invalid }))
      .status,
  ).toBe(400);
  const large = form();
  large.set("files", new File([new Uint8Array(20_000_001)], "large.bin"));
  expect(
    (await app.request("/api/chat/uploads", { method: "POST", headers: auth, body: large })).status,
  ).toBe(400);
  const overBodyLimit = form();
  overBodyLimit.set("files", new File([new Uint8Array(21_000_001)], "larger.bin"));
  expect(
    (await app.request("/api/chat/uploads", { method: "POST", headers: auth, body: overBodyLimit }))
      .status,
  ).toBe(413);
});
