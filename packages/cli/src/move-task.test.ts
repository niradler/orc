import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrcClient } from "@orc/sdk/client";
import { moveTask } from "./move-task.js";
import { resolveRemoteBase } from "./remote-target.js";

const root = mkdtempSync(join(tmpdir(), "orc-move-"));
const secret = "move-secret";
const servers: Array<ReturnType<typeof Bun.spawn>> = [];

async function start(name: string): Promise<string> {
  const db = join(root, `${name}.sqlite`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ORC_API_BASE") env[key] = value;
  }
  env.ORC_DB_PATH = db;
  env.ORC_API_SECRET = secret;
  const proc = Bun.spawn(["bun", join(import.meta.dir, "move-task-server.ts")], {
    cwd: join(import.meta.dir, "..", "..", ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  servers.push(proc);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const port = await Promise.race([
    (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value);
        const line = buffer.split("\n").find((item) => /^\d+$/.test(item.trim()));
        if (line) return line.trim();
      }
      throw new Error(await new Response(proc.stderr).text());
    })(),
    Bun.sleep(15000).then(() => {
      throw new Error(`API ${name} did not start`);
    }),
  ]);
  return `http://127.0.0.1:${port}`;
}

afterAll(() => {
  for (const server of servers) server.kill();
  rmSync(root, { recursive: true, force: true });
});

describe("remote target", () => {
  test("should accept an API base or host:port and reject a profile name", () => {
    expect(resolveRemoteBase("https://orc.example.com/api/")).toBe("https://orc.example.com");
    expect(resolveRemoteBase("127.0.0.1:7711")).toBe("http://127.0.0.1:7711");
    expect(() => resolveRemoteBase("cloud")).toThrow(/ORC_API_BASE/);
  });
});

describe("task move", () => {
  test("should copy an open task and its comment, then delete it on the source", async () => {
    const [sourceUrl, destinationUrl] = await Promise.all([start("source"), start("dest")]);
    const source = createOrcClient({ baseUrl: sourceUrl, secret, source: "cli" });
    const destination = createOrcClient({ baseUrl: destinationUrl, secret, source: "cli" });
    const project = await source.projects.create({
      name: "move-proj",
      description: "From the laptop",
    });
    if (project.error || !project.data) throw new Error(project.error?.error);
    const task = await source.tasks.create({
      project_id: project.data.id,
      title: "Carry this task",
      body: "Open work",
      status: "doing",
    });
    if (task.error || !task.data) throw new Error(task.error?.error);
    const comment = await fetch(`${sourceUrl}/api/tasks/${task.data.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ content: "note from the laptop", author: "ada" }),
    });
    expect(comment.status).toBe(201);

    const moved = await moveTask({ source, destination, taskId: task.data.id });
    expect(moved.source_deleted).toBe(true);
    expect(moved.counts.tasks).toBe(1);
    expect(moved.counts.comments).toBe(1);

    const gone = await source.tasks.get(task.data.id);
    expect(gone.error?.code).toBe("NOT_FOUND");
    const projects = await destination.projects.getByName("move-proj");
    expect(projects.data?.description).toBe("From the laptop");
    const projectId = projects.data?.id;
    if (!projectId) throw new Error("destination project missing");
    const copy = await destination.tasks.list({ project_id: projectId, limit: 20 });
    expect(copy.data?.tasks).toEqual([
      expect.objectContaining({ title: "Carry this task", status: "doing", body: "Open work" }),
    ]);
    const comments = await fetch(
      `${destinationUrl}/api/tasks/${copy.data?.tasks[0]?.id}/comments`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    expect(await comments.json()).toMatchObject({
      comments: [expect.objectContaining({ content: "note from the laptop" })],
    });
  });
});
