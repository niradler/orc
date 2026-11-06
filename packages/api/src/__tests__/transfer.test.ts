import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUserFlowsDir, reloadFlows } from "@orc/core/flow-service";
import { decryptSecret } from "@orc/core/secrets";
import { ChannelStore } from "@orc/db/channels";
import { getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const scope = join(tmpdir(), `orc-transfer-${process.pid}`);
const flowName = "zz-transfer-179";
const bot = "bot-token-value";
const envSecret = "env-token-value";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  rmSync(join(getUserFlowsDir(), flowName), { recursive: true, force: true });
  rmSync(scope, { recursive: true, force: true });
  mkdirSync(join(scope, ".orc", "flows", flowName), { recursive: true });
  writeFileSync(
    join(scope, ".orc", "flows", flowName, "flow.json"),
    JSON.stringify({
      name: flowName,
      description: "Moved with the project",
      entry: "work",
      nodes: {
        work: { kind: "agent", skill: "orc-coder", outcomes: ["ok"] },
        done: { kind: "terminal" },
      },
      edges: [{ from: "work", to: "done", when: { outcome: "ok" } }],
    }),
  );
  reloadFlows();
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
  rmSync(join(getUserFlowsDir(), flowName), { recursive: true, force: true });
  rmSync(scope, { recursive: true, force: true });
  reloadFlows();
});

function wipe() {
  const db = getSqlite();
  db.exec(`
    DELETE FROM webhook_subscriptions;
    DELETE FROM webhook_delivery_runs;
    DELETE FROM webhook_deliveries;
    DELETE FROM webhooks;
    DELETE FROM task_links;
    DELETE FROM comments;
    DELETE FROM tasks;
    DELETE FROM memories;
    DELETE FROM memory_changes;
    DELETE FROM memory_usage;
    DELETE FROM jobs;
    DELETE FROM channel_targets;
    DELETE FROM channel_routes;
    DELETE FROM channels;
    DELETE FROM rule_heads;
    DELETE FROM rule_revisions;
    DELETE FROM projects;
  `);
}

describe("project export and import", () => {
  test("should round-trip tasks, comments, memories and jobs with secrets removed", async () => {
    const project = await (
      await req(app, "POST", "/projects", {
        name: "transfer-proj",
        description: "Laptop project",
        scope,
        git_remote_url: "https://github.com/acme/app.git",
        tags: ["move"],
        max_workers: 2,
      })
    ).json();
    const open = await (
      await req(app, "POST", "/tasks", {
        project_id: project.id,
        title: "Keep me open",
        body: "The body comes along",
        status: "doing",
      })
    ).json();
    getSqlite().query("UPDATE tasks SET flow_name=? WHERE id=?").run(flowName, open.id);
    const other = await (
      await req(app, "POST", "/tasks", {
        project_id: project.id,
        title: "Already done",
        status: "todo",
      })
    ).json();
    await req(app, "PATCH", `/tasks/${other.id}`, { status: "done" });
    expect(
      (
        await req(app, "POST", `/tasks/${open.id}/comments`, {
          content: "still open",
          author: "ada",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await req(app, "POST", `/tasks/${open.id}/links`, {
          to_task_id: other.id,
          link_type: "blocks",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await req(app, "POST", "/memories", {
          project_id: project.id,
          name: "build-notes",
          description: "How to build",
          content: "Run bun test",
          priority: 40,
        })
      ).status,
    ).toBe(201);
    const job = await (
      await req(app, "POST", "/jobs", {
        name: "nightly-transfer",
        command: "echo keep",
        trigger_type: "manual",
        enabled: true,
        project_id: project.id,
        env_vars: { LOG_LEVEL: "debug", API_TOKEN: envSecret },
      })
    ).json();
    const hookRes = await req(app, "POST", "/webhooks", {
      name: "Build hook",
      provider: "generic",
      project_id: project.id,
      job_id: job.id,
      events: ["build"],
    });
    expect(hookRes.status).toBe(201);
    const createdHook = await hookRes.json();
    new ChannelStore(getSqlite()).saveConnection({
      id: "lab-chat",
      name: "Lab chat",
      provider: "telegram",
      enabled: true,
      revision: 0,
      config: {},
      credentials: { bot_token: bot },
      targets: [
        {
          id: "main",
          name: "Main",
          chat_id: "42",
          user_ids: [],
          project_ids: [project.id],
          inbound: true,
          outbound: true,
          attention: false,
        },
      ],
      routes: [],
    });
    new RuleStore(getSqlite()).activate(
      {
        workspace: scope,
        project_id: project.id,
        rules: [
          {
            id: "deny-delete",
            kind: "event",
            enabled: true,
            reason: "No delete",
            scope: { agents: "all", events: ["pre_tool"] },
            filter: {
              match: "all",
              conditions: [{ predicate: { field: "tool", operator: "in", value: ["Bash"] } }],
            },
            target: { type: "block" },
          },
        ],
      },
      null,
      "Initial policy",
    );

    const exported = await req(app, "POST", "/export", { project: "transfer-proj" });
    expect(exported.status).toBe(200);
    const bundle = await exported.json();
    const text = JSON.stringify(bundle);
    expect(text).not.toContain(createdHook.secret);
    expect(text).not.toContain(createdHook.token);
    expect(text).not.toContain(bot);
    expect(text).not.toContain(envSecret);
    expect(bundle.needs_reentry.map((item: { field: string }) => item.field)).toEqual(
      expect.arrayContaining(["secret", "token", "bot_token", "API_TOKEN"]),
    );
    const statuses: Array<[string, string]> = bundle.tasks.map(
      (task: { title: string; status: string }): [string, string] => [task.title, task.status],
    );
    statuses.sort((a, b) => a[0].localeCompare(b[0]));
    expect(statuses).toEqual([
      ["Already done", "done"],
      ["Keep me open", "doing"],
    ]);
    expect(bundle.jobs[0].env_vars).toEqual({ LOG_LEVEL: "debug" });
    expect(bundle.flows.map((flow: { name: string }) => flow.name)).toContain(flowName);
    expect(bundle.channels[0].credential_fields).toEqual(["bot_token"]);
    expect(bundle.rules).toHaveLength(1);

    wipe();
    const imported = await req(app, "POST", "/import", bundle);
    expect(imported.status).toBe(200);
    const result = await imported.json();
    expect(result.created_project).toBe(true);
    expect(result.counts).toMatchObject({
      tasks: 2,
      comments: 1,
      memories: 1,
      jobs: 1,
      webhooks: 1,
      flows: 1,
      channels: 1,
      rules: 1,
      links: 1,
    });
    expect(result.issued[0].secret).not.toBe(createdHook.secret);
    expect(result.issued[0].token).not.toBe(createdHook.token);

    const db = getSqlite();
    const restored = db
      .query<{ id: string; scope: string; max_workers: number }, [string]>(
        "SELECT id, scope, max_workers FROM projects WHERE name=?",
      )
      .get("transfer-proj");
    expect(restored).toMatchObject({ scope, max_workers: 2 });
    const tasks = db
      .query<{ title: string; status: string; body: string | null; flow_name: string | null }, []>(
        "SELECT title, status, body, flow_name FROM tasks ORDER BY title",
      )
      .all();
    expect(tasks).toEqual([
      { title: "Already done", status: "done", body: null, flow_name: null },
      { title: "Keep me open", status: "doing", body: "The body comes along", flow_name: flowName },
    ]);
    expect(
      db
        .query<{ content: string }, []>("SELECT content FROM comments")
        .all()
        .map((row) => row.content),
    ).toEqual(["still open"]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_links").get()?.n).toBe(1);
    expect(
      db
        .query<{ content: string }, []>("SELECT content FROM memories WHERE name='build-notes'")
        .get()?.content,
    ).toBe("Run bun test");
    expect(
      db
        .query<{ command: string; env_vars: string; enabled: number }, []>(
          "SELECT command, env_vars, enabled FROM jobs WHERE name='nightly-transfer'",
        )
        .get(),
    ).toEqual({
      command: "echo keep",
      env_vars: JSON.stringify({ LOG_LEVEL: "debug" }),
      enabled: 1,
    });
    const stored = db
      .query<{ secret: string; token: string }, []>("SELECT secret, token FROM webhooks")
      .get();
    expect(stored?.token).toBe(result.issued[0].token);
    expect(decryptSecret(stored?.secret ?? "")).toBe(result.issued[0].secret);
    expect(JSON.stringify(db.query("SELECT credentials FROM channels").get())).not.toContain(bot);
    expect(
      db.query<{ enabled: number }, []>("SELECT enabled FROM channels WHERE id='lab-chat'").get()
        ?.enabled,
    ).toBe(0);
    expect(new RuleStore(db).active(scope)[0]?.policy?.rules[0]?.id).toBe("deny-delete");
    expect(bundle.project.settings.git_remote_url).toBe("https://github.com/acme/app.git");
    const again = await req(app, "POST", "/import", bundle);
    expect(again.status).toBe(200);
    expect((await again.json()).counts.tasks).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks").get()?.n).toBe(2);
  });
});
