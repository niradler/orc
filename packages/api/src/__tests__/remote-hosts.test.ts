import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath } from "@orc/core/config";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "orc-remote-hosts-"));
const destHome = join(root, "dest-home");
let app: ReturnType<typeof createApp>;
let destination: ReturnType<typeof Bun.spawn> | null = null;
let destUrl = "";

async function destFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${destUrl}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer dest-secret",
      Connection: "close",
    },
  });
}

async function startDestination(): Promise<void> {
  mkdirSync(destHome, { recursive: true });
  destination = Bun.spawn(
    [process.execPath, join(import.meta.dirname, "fixtures", "send-destination.ts")],
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
        HOME: destHome,
        USERPROFILE: destHome,
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const stdout = destination.stdout;
  if (!stdout || typeof stdout === "number") throw new Error("destination stdout is not piped");
  const reader = stdout.getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The destination ORC exited before reporting its port");
    buffer += new TextDecoder().decode(value);
    const match = buffer.match(/PORT=(\d+)/);
    if (match) {
      destUrl = `http://127.0.0.1:${match[1]}`;
      break;
    }
  }
  reader.releaseLock();
  const deadline = Date.now() + 20_000;
  while (
    !(await fetch(`${destUrl}/api/health`)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    if (Date.now() > deadline) throw new Error("The destination ORC did not become healthy");
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  app = setupTestApp();
  await startDestination();
});

afterAll(async () => {
  if (destination) {
    destination.kill();
    await destination.exited;
  }
  teardownTestApp();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("remote ORC hosts", () => {
  let id = "";

  test("saves a remote host in config.json and never returns its token", async () => {
    const saved = await req(app, "POST", "/remote-hosts", {
      label: "Devbox",
      url: `${destUrl}/api/`,
      token: "dest-secret",
      headers: [{ name: "CF-Access-Client-Id", value: "client" }],
    });
    expect(saved.status).toBe(200);
    const { hosts } = await saved.json<{
      hosts: { id: string; url: string; has_token: boolean }[];
    }>();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.url).toBe(destUrl);
    expect(hosts[0]?.has_token).toBe(true);
    expect(JSON.stringify(hosts)).not.toContain("dest-secret");
    id = hosts[0]?.id ?? "";
    expect(readFileSync(globalConfigPath(), "utf8")).toContain('"token": "dest-secret"');

    const blocked = await req(app, "POST", "/remote-hosts", {
      label: "Bad",
      url: destUrl,
      headers: [{ name: "Authorization", value: "x" }],
    });
    expect(blocked.status).toBe(400);

    // Names are trimmed before the blocklist check, and invalid tokens are
    // rejected here instead of failing opaquely at dial time.
    const padded = await req(app, "POST", "/remote-hosts", {
      label: "Bad",
      url: destUrl,
      headers: [{ name: "  Authorization  ", value: "x" }],
    });
    expect(padded.status).toBe(400);
    const invalid = await req(app, "POST", "/remote-hosts", {
      label: "Bad",
      url: destUrl,
      headers: [{ name: "X Bad Name", value: "x" }],
    });
    expect(invalid.status).toBe(400);
  });

  test("editing headers keeps a blank stored value, adds new ones, and never returns values", async () => {
    const kept = await req(app, "POST", "/remote-hosts", {
      id,
      label: "Devbox",
      url: destUrl,
      headers: [
        { name: "CF-Access-Client-Id", value: "" },
        { name: "CF-Access-Client-Secret", value: "cfast_secret" },
      ],
    });
    expect(kept.status).toBe(200);
    const { hosts } = await kept.json<{ hosts: { header_names: string[] }[] }>();
    expect(hosts[0]?.header_names).toEqual(["CF-Access-Client-Id", "CF-Access-Client-Secret"]);
    expect(JSON.stringify(hosts)).not.toContain("cfast_secret");
    const config = readFileSync(globalConfigPath(), "utf8");
    expect(config).toContain('"value": "client"');
    expect(config).toContain('"value": "cfast_secret"');

    const missingValue = await req(app, "POST", "/remote-hosts", {
      id,
      label: "Devbox",
      url: destUrl,
      headers: [
        { name: "CF-Access-Client-Id", value: "" },
        { name: "X-New", value: "" },
      ],
    });
    expect(missingValue.status).toBe(400);

    const removed = await req(app, "POST", "/remote-hosts", {
      id,
      label: "Devbox",
      url: destUrl,
      headers: [{ name: "CF-Access-Client-Id", value: "" }],
    });
    expect(removed.status).toBe(200);
    const after = await removed.json<{ hosts: { header_names: string[] }[] }>();
    expect(after.hosts[0]?.header_names).toEqual(["CF-Access-Client-Id"]);
    expect(readFileSync(globalConfigPath(), "utf8")).not.toContain("cfast_secret");
  });

  test("tests the connection and lists the remote's hosts and projects", async () => {
    const tested = await (await req(app, "POST", `/remote-hosts/${id}/test`)).json();
    expect(tested).toMatchObject({ ok: true, error: null });
    const targets = await req(app, "GET", `/remote-hosts/${id}/hosts`);
    expect(targets.status).toBe(200);
    expect(await targets.json()).toMatchObject({ hosts: expect.any(Array) });
    await destFetch("/projects", { method: "POST", body: JSON.stringify({ name: "remote-proj" }) });
    const projects = await (await req(app, "GET", `/remote-hosts/${id}/projects`)).json();
    expect(projects.projects.map((project: { name: string }) => project.name)).toContain(
      "remote-proj",
    );
  });

  test("browses and creates folders through the remote server", async () => {
    const listed = await req(
      app,
      "GET",
      `/remote-hosts/${id}/browse?path=${encodeURIComponent(destHome)}&host=`,
    );
    expect(listed.status).toBe(200);
    const listing = await listed.json<{ path: string; directories: string[] }>();
    expect(listing.path).toBe(destHome);

    const created = await req(app, "POST", `/remote-hosts/${id}/browse/folders`, {
      host: null,
      parent: destHome,
      name: "picked-here",
    });
    expect(created.status).toBe(200);
    expect((await created.json<{ path: string }>()).path).toBe(join(destHome, "picked-here"));
    const after = await (
      await req(app, "GET", `/remote-hosts/${id}/browse?path=${encodeURIComponent(destHome)}`)
    ).json<{ directories: string[] }>();
    expect(after.directories).toContain("picked-here");
  });

  test("forwards the requested host, including an empty one, to the remote server", async () => {
    const original = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(
        JSON.stringify({ host: null, path: destHome, parent: null, directories: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const own = await req(
        app,
        "GET",
        `/remote-hosts/${id}/browse?path=${encodeURIComponent(destHome)}&host=`,
      );
      expect(own.status).toBe(200);
      const aliased = await req(
        app,
        "GET",
        `/remote-hosts/${id}/browse?path=${encodeURIComponent(destHome)}&host=my-ssh-host`,
      );
      expect(aliased.status).toBe(200);
    } finally {
      globalThis.fetch = original;
    }
    expect(requested.map((url) => new URL(url).searchParams.get("host"))).toEqual([
      "",
      "my-ssh-host",
    ]);
  });

  test("a wrong token fails the test with a clear reason", async () => {
    await req(app, "POST", "/remote-hosts", {
      id,
      label: "Devbox",
      url: destUrl,
      token: "wrong",
    });
    const tested = await (await req(app, "POST", `/remote-hosts/${id}/test`)).json();
    expect(tested).toMatchObject({ ok: false, error: "Devbox needs a valid access token" });
    await req(app, "POST", "/remote-hosts", {
      id,
      label: "Devbox",
      url: destUrl,
      token: "dest-secret",
    });
  });

  test("a chat started on a remote host runs and finishes there after this server detaches", async () => {
    const response = await req(app, "POST", "/chat/stream", {
      messages: [{ role: "user", content: "Reply with exactly: REMOTE-OK." }],
      workspace: { host: `orc:${id}`, cwd: destHome },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)));
    expect(events.at(-1)).toEqual({ type: "done" });
    const event = events[0] as {
      type: string;
      thread_id: string;
      host_label: string;
      open_url: string;
    };
    expect(event).toMatchObject({ type: "remote", host_label: "Devbox" });
    expect(event.open_url).toBe(`${destUrl}/chat?chatThread=${event.thread_id}`);

    const deadline = Date.now() + 20_000;
    let reply = "";
    while (!reply.includes("REMOTE-OK") && Date.now() < deadline) {
      const thread = (await (await destFetch(`/chat/threads/${event.thread_id}`)).json()) as {
        messages?: unknown[];
      };
      reply = JSON.stringify(thread.messages ?? []);
      await Bun.sleep(200);
    }
    expect(reply).toContain("REMOTE-OK");
    const local = await req(app, "GET", `/chat/threads/${event.thread_id}`);
    expect(local.status).toBe(404);
  }, 30_000);

  test("an unknown remote host is refused before anything starts", async () => {
    const response = await req(app, "POST", "/chat/stream", {
      messages: [{ role: "user", content: "hi" }],
      workspace: { host: "orc:missing" },
    });
    expect(response.status).toBe(404);
  });

  test("deleting removes it from config.json", async () => {
    const removed = await (await req(app, "DELETE", `/remote-hosts/${id}`)).json();
    expect(removed.hosts).toEqual([]);
    expect(readFileSync(globalConfigPath(), "utf8")).not.toContain("dest-secret");
  });
});
