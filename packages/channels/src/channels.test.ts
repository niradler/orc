import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelConnectionSchema,
  ChannelMessageSchema,
  ChannelRouteSchema,
} from "@orc/core/channels";
import { resetConfig } from "@orc/core/config";
import { ChannelStore } from "@orc/db/channels";
import type { ChannelTransport } from "./providers.js";
import { renderMessage } from "./render.js";
import { routeMessage } from "./routing.js";
import { ChannelService } from "./service.js";

const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const home = mkdtempSync(join(tmpdir(), "orc-channels-"));
beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  resetConfig();
});
afterAll(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});
const inbound = {
  connection: "test",
  sender: "nir",
  chat: "private",
  text: "help deploy",
  message_id: "m1",
  kind: "message" as const,
  is_direct: true,
  is_mention: false,
};
const route = (id: string, condition: unknown) =>
  ChannelRouteSchema.parse({
    id,
    name: id,
    condition,
    action: { type: "agent", agent: "codex", project_id: "project" },
  });

test("ordered nested AND/OR/NOT routing is first-match and defaults to no route", () => {
  const a = route("a", {
    all: [
      { field: "is_direct", op: "is", value: true },
      {
        any: [
          { field: "text", op: "starts_with", value: "help" },
          { field: "command", op: "is", value: "deploy" },
        ],
      },
      { not: { field: "sender", op: "in", value: ["blocked"] } },
    ],
  });
  const b = route("b", { field: "is_direct", op: "is", value: true });
  expect(routeMessage([a, b], inbound)?.id).toBe("a");
  expect(routeMessage([{ ...a, enabled: false }, b], inbound)?.id).toBe("b");
  expect(routeMessage([a], { ...inbound, sender: "blocked" })).toBeUndefined();
  expect(() => route("bad", { all: [] })).toThrow();
  expect(() => route("bad", { field: "text", op: "matches", value: "(a+)+" })).toThrow();
});

test("Otherwise is explicit, last, optional and does not shadow earlier enabled rules", () => {
  const specific = route("specific", { field: "is_direct", op: "is", value: true });
  const fallback = route("otherwise", { always: true });
  expect(routeMessage([specific, fallback], inbound)?.id).toBe("specific");
  expect(routeMessage([specific, fallback], { ...inbound, is_direct: false })?.id).toBe(
    "otherwise",
  );
  expect(routeMessage([{ ...specific, enabled: false }, fallback], inbound)?.id).toBe("otherwise");
  expect(routeMessage([{ ...fallback, enabled: false }], inbound)).toBeUndefined();
  const connection = {
    id: "test",
    name: "test",
    provider: "telegram",
    routes: [specific, fallback],
  };
  expect(ChannelConnectionSchema.parse(connection).routes).toHaveLength(2);
  expect(() =>
    ChannelConnectionSchema.parse({ ...connection, routes: [fallback, specific] }),
  ).toThrow("Otherwise rule must be last");
  expect(() =>
    ChannelConnectionSchema.parse({
      ...connection,
      routes: [fallback, { ...fallback, id: "second" }],
    }),
  ).toThrow("Otherwise rule must be last");
  expect(() => route("bad", { always: false })).toThrow();
  expect(() => route("bad", { not: { always: true } })).toThrow();
});

test("Otherwise never grants an unapproved sender or a forbidden project access", async () => {
  const db = new Database(":memory:");
  const service = new ChannelService(new ChannelStore(db));
  const current = ChannelConnectionSchema.parse({
    id: "test",
    name: "test",
    provider: "telegram",
    enabled: true,
    targets: [
      {
        id: "me",
        name: "me",
        chat_id: "private",
        user_ids: ["nir"],
        project_ids: ["allowed"],
        inbound: true,
      },
    ],
    routes: [route("otherwise", { always: true })],
  });
  service.connections = () => [current];
  let calls = 0;
  service.handler = async () => {
    calls++;
  };
  await service.receive({ ...inbound, sender: "intruder" });
  await service.receive(inbound);
  expect(calls).toBe(0);
  current.routes[0] = {
    ...route("otherwise", { always: true }),
    action: { type: "agent", project_id: "allowed", agent: "default" },
  };
  await service.receive({ ...inbound, message_id: "allowed" });
  expect(calls).toBe(1);
  db.close();
});

test("Markdown renders natively, escapes HTML and preserves links/code", () => {
  const msg = ChannelMessageSchema.parse({
    text: "**Done** [Open](https://example.com)\n\n`<secret>` <script>",
  });
  const telegram = renderMessage("telegram", msg).payloads[0];
  expect(telegram?.text).toContain("<b>Done</b>");
  expect(telegram?.text).toContain('<a href="https://example.com">Open</a>');
  expect(telegram?.text).toContain("<code>&lt;secret&gt;</code>");
  expect(telegram?.text).not.toContain("<script>");
  expect(renderMessage("slack", msg).payloads[0]?.text).toContain("*Done*");
});

test("long text is split without losing content or Unicode", () => {
  const source = "😀<&>".repeat(2000);
  const rendered = renderMessage(
    "telegram",
    ChannelMessageSchema.parse({ text: source, format: "plain" }),
  );
  expect(rendered.payloads.length).toBeGreaterThan(1);
  expect(rendered.payloads.every((p) => String(p.text).length < 4096)).toBe(true);
  expect(rendered.payloads.map((p) => p.text).join("")).toBe(
    source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
});
test("Slack common rendering preserves quotation marks and task-list state", () => {
  const result = renderMessage(
    "slack",
    ChannelMessageSchema.parse({ text: 'A "quoted" summary\n\n- [x] Done\n- [ ] Pending' }),
  );
  expect(result.payloads[0]?.text).toContain('A "quoted" summary');
  expect(result.payloads[0]?.text).toContain("☑ Done");
  expect(result.payloads[0]?.text).toContain("☐ Pending");
  const links = [{ label: "Open task", url: "https://example.com/task" }];
  const long = renderMessage(
    "slack",
    ChannelMessageSchema.parse({ text: "*<&>".repeat(1000), links }),
  );
  expect(long.payloads.length).toBeGreaterThan(1);
  expect(long.payloads.every((p) => p.mrkdwn === false)).toBe(true);
  const blocks = long.payloads.at(-1)?.blocks as { text?: { type: string; text: string } }[];
  expect(blocks[0]?.text?.type).toBe("plain_text");
  expect(blocks[0]?.text?.text.length).toBeLessThanOrEqual(3000);
  const plain = renderMessage(
    "slack",
    ChannelMessageSchema.parse({ text: "*literal* <tag>", format: "plain", links }),
  );
  expect(
    (plain.payloads[0]?.blocks as { text: { text: string; type: string } }[] | undefined)?.[0]
      ?.text,
  ).toEqual({ type: "plain_text", text: "*literal* <tag>" });
  const labels = renderMessage(
    "slack",
    ChannelMessageSchema.parse({
      text: "Task",
      links: [{ label: "a".repeat(100), url: "https://example.com/task" }],
    }),
  );
  expect(labels.warnings.join(" ")).toContain("75 characters");
  expect(JSON.stringify(labels.payloads)).toContain(`"text":"${"a".repeat(75)}"`);
});

test("queued messages recheck authorization before invoking an agent", async () => {
  const db = new Database(":memory:");
  const service = new ChannelService(new ChannelStore(db));
  let current = ChannelConnectionSchema.parse({
    id: "test",
    name: "test",
    provider: "telegram",
    enabled: true,
    targets: [{ id: "me", name: "me", chat_id: "private", user_ids: ["nir"], inbound: true }],
    routes: [route("route", { field: "is_direct", op: "is", value: true })],
  });
  service.connections = () => [current];
  let calls = 0;
  let release: () => void = () => {};
  const pause = new Promise<void>((r) => {
    release = r;
  });
  service.handler = async () => {
    calls++;
    await pause;
  };
  const first = service.receive(inbound);
  await Bun.sleep(0);
  const second = service.receive({ ...inbound, message_id: "queued" });
  await Bun.sleep(0);
  current = { ...current, targets: current.targets.map((t) => ({ ...t, user_ids: [] })) };
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
  db.close();
});

test("Telegram polling conflicts remain stopped until an explicit configuration save", async () => {
  const db = new Database(":memory:");
  let starts = 0;
  const transport: ChannelTransport = {
    identity: async () => ({ id: "bot", name: "bot" }),
    send: async () => "1",
    edit: async () => {},
    start: async (_receive, fail) => {
      starts++;
      fail("http_409_code_409");
    },
    stop: async () => {},
  };
  const service = new ChannelService(new ChannelStore(db), () => transport);
  await service.save({
    id: "conflict",
    name: "conflict",
    provider: "telegram",
    enabled: true,
    credentials: { token: "conflict" },
  });
  await service.reconcile();
  await service.reconcile();
  expect(starts).toBe(1);
  expect(service.list().find((c) => c.id === "conflict")?.error).toContain(
    "Another Telegram poller",
  );
  await service.save({ ...service.connection("conflict"), credentials: {} });
  expect(starts).toBe(2);
  await service.stop();
  db.close();
});

test("native overrides pass arbitrary provider fields intact; credentials are hidden; sends are idempotent", async () => {
  const db = new Database(":memory:");
  const sent: unknown[] = [];
  const transport: ChannelTransport = {
    identity: async () => ({ id: "bot", name: "bot" }),
    send: async (payload) => {
      sent.push(payload);
      return "1";
    },
    edit: async () => {},
    start: async () => {},
    stop: async () => {},
  };
  const service = new ChannelService(new ChannelStore(db), () => transport);
  await service.save({
    id: "test",
    name: "Test",
    provider: "telegram",
    enabled: true,
    credentials: { token: "private-token" },
    targets: [{ id: "me", name: "Nir", chat_id: "private" }],
  });
  expect(JSON.stringify(service.list())).not.toContain("private-token");
  const input = {
    connection: "test",
    target: "me",
    message: { text: "**generated**" },
    overrides: {
      text: "<i>native</i>",
      parse_mode: "HTML",
      future_provider_option: { array: [1, true, { nested: "unchanged" }] },
    },
    idempotency_key: "same",
  };
  const receipt = await service.send(input);
  expect(receipt.status).toBe("accepted");
  expect(sent[0]).toMatchObject({ ...input.overrides, chat_id: "private" });
  expect((await service.send(input)).id).toBe(receipt.id);
  expect(sent).toHaveLength(1);
  expect(service.send({ ...input, message: { text: "different" } })).rejects.toThrow("Idempotency");
  expect(service.send({ ...input, overrides: { chat_id: "outsider" } })).rejects.toThrow("routing");
  await service.stop();
  db.close();
});

test("pairing is expiring and single-use; leases isolate transport owners", () => {
  const db = new Database(":memory:");
  let time = 1000;
  const store = new ChannelStore(db, () => time);
  const p = store.createPairing("test");
  expect(store.offerPairing("wrong", p.token, { chat_id: "a", user_id: "a", name: "a" })).toBe(
    false,
  );
  expect(store.offerPairing("test", p.token, { chat_id: "a", user_id: "a", name: "a" })).toBe(true);
  expect(store.offerPairing("test", p.token, { chat_id: "b", user_id: "b", name: "b" })).toBe(
    false,
  );
  store.confirm(p.id);
  expect(() => store.confirm(p.id)).toThrow();
  expect(store.lease("bot", "one")).toBe(true);
  expect(store.lease("bot", "two")).toBe(false);
  time += 50000;
  expect(store.lease("bot", "two")).toBe(true);
  time += 600000;
  expect(() => store.pairing(p.id)).toThrow();
  db.close();
});

test("unauthorized inbound and nonmatching event kinds never launch agents", async () => {
  const db = new Database(":memory:");
  const service = new ChannelService(new ChannelStore(db));
  let calls = 0;
  service.handler = async () => {
    calls++;
  };
  // Inject only configuration reading, keeping production dispatch/authorization/dedup intact.
  service.connections = () => [
    ChannelConnectionSchema.parse({
      id: "test",
      name: "test",
      provider: "telegram",
      enabled: true,
      targets: [{ id: "me", name: "me", chat_id: "private", user_ids: ["nir"], inbound: true }],
      routes: [
        route("route", {
          all: [
            { field: "kind", op: "is", value: "message" },
            { field: "is_direct", op: "is", value: true },
          ],
        }),
      ],
    }),
  ];
  await service.receive({ ...inbound, sender: "attacker" });
  await service.receive({ ...inbound, kind: "action" });
  expect(calls).toBe(0);
  await service.receive({ ...inbound, message_id: "m2" });
  await service.receive({ ...inbound, message_id: "m2" });
  expect(calls).toBe(1);
  db.close();
});

test("an unreadable channel credential does not break legacy account selection", () => {
  const db = new Database(":memory:");
  const service = new ChannelService(new ChannelStore(db));
  service.connections = () => [
    ChannelConnectionSchema.parse({
      id: "broken",
      name: "broken",
      provider: "telegram",
      enabled: true,
      credentials: { token: "enc:v1:broken" },
    }),
  ];
  expect(service.managesAccount("telegram", "legacy-token")).toBe(false);
  db.close();
});

test("delivery options retain long-message chunking and edits stay bound to the original destination", async () => {
  const db = new Database(":memory:");
  const sent: Record<string, unknown>[] = [];
  const edits: Record<string, unknown>[] = [];
  let current = ChannelConnectionSchema.parse({
    id: "test",
    name: "Test",
    provider: "telegram",
    enabled: true,
    targets: [{ id: "me", name: "Me", chat_id: "original" }],
  });
  const transport: ChannelTransport = {
    identity: async () => ({ id: "bot", name: "bot" }),
    start: async () => {},
    stop: async () => {},
    send: async (payload) => {
      sent.push(payload);
      return String(sent.length);
    },
    edit: async (_id, payload) => {
      edits.push(payload);
    },
  };
  const service = new ChannelService(new ChannelStore(db), () => transport);
  service.connections = () => [current];
  const long = await service.send({
    connection: "test",
    target: "me",
    message: { text: "hello ".repeat(1500) },
    overrides: { disable_notification: true },
  });
  expect(long.status).toBe("accepted");
  expect(sent.length).toBeGreaterThan(1);
  expect(
    sent.every(
      (p) =>
        p.disable_notification === true && p.parse_mode === "HTML" && String(p.text).length < 4096,
    ),
  ).toBe(true);
  expect(long.warnings.length).toBe(1);
  const original = await service.send({
    connection: "test",
    target: "me",
    message: { text: "Original" },
    thread_id: "123",
  });
  await service.edit(original.id, { message: ChannelMessageSchema.parse({ text: "Updated" }) });
  expect(edits[0]?.message_thread_id).toBe(123);
  await expect(
    service.edit(original.id, {
      message: ChannelMessageSchema.parse({ text: "Wrong thread" }),
      thread_id: "124",
    }),
  ).rejects.toThrow("destination");
  current = { ...current, targets: current.targets.map((t) => ({ ...t, chat_id: "replacement" })) };
  await expect(
    service.edit(original.id, { message: ChannelMessageSchema.parse({ text: "Wrong chat" }) }),
  ).rejects.toThrow("destination");
  expect(edits).toHaveLength(1);
  db.close();
});

test("revoking outbound permissions stops remaining message chunks", async () => {
  const db = new Database(":memory:");
  let sends = 0;
  let current = ChannelConnectionSchema.parse({
    id: "test",
    name: "Test",
    provider: "telegram",
    enabled: true,
    targets: [{ id: "me", name: "Me", chat_id: "original" }],
  });
  const transport: ChannelTransport = {
    identity: async () => ({ id: "bot", name: "bot" }),
    start: async () => {},
    stop: async () => {},
    edit: async () => {},
    send: async () => {
      sends++;
      current = { ...current, targets: current.targets.map((t) => ({ ...t, outbound: false })) };
      return String(sends);
    },
  };
  const service = new ChannelService(new ChannelStore(db), () => transport);
  service.connections = () => [current];
  const result = await service.send({
    connection: "test",
    target: "me",
    message: { text: "long ".repeat(2000) },
  });
  expect(result.status).toBe("partial");
  expect(sends).toBe(1);
  expect(service.get(result.id).status).toBe("partial");
  db.close();
});

test("rotating an environment credential replaces only its owned transport", async () => {
  const db = new Database(":memory:");
  const previous = process.env.ORC_TELEGRAM_TOKEN;
  const tokens: string[] = [];
  let stops = 0;
  const service = new ChannelService(new ChannelStore(db), (_connection, credentials) => {
    tokens.push(credentials.token ?? "");
    return {
      identity: async () => ({ id: "bot", name: "bot" }),
      send: async () => "1",
      edit: async () => {},
      start: async () => {},
      stop: async () => {
        stops++;
      },
    };
  });
  try {
    process.env.ORC_TELEGRAM_TOKEN = "first-fixture";
    await service.save({
      id: "rotation",
      name: "Rotation",
      provider: "telegram",
      enabled: true,
      credentials: { token: "env:ORC_TELEGRAM_TOKEN" },
    });
    process.env.ORC_TELEGRAM_TOKEN = "second-fixture";
    await service.reconcile();
    expect(tokens).toEqual(["first-fixture", "second-fixture"]);
    expect(stops).toBe(1);
    expect(service.list().find((c) => c.id === "rotation")?.status).toBe("ready");
  } finally {
    await service.stop();
    db.close();
    if (previous === undefined) delete process.env.ORC_TELEGRAM_TOKEN;
    else process.env.ORC_TELEGRAM_TOKEN = previous;
  }
});

test("shutdown during identity verification cannot start a new listener afterward", async () => {
  const db = new Database(":memory:");
  let resolveIdentity: (value: { id: string; name: string }) => void = () => {};
  let starts = 0;
  const identity = new Promise<{ id: string; name: string }>((resolve) => {
    resolveIdentity = resolve;
  });
  const service = new ChannelService(new ChannelStore(db), () => ({
    identity: () => identity,
    send: async () => "1",
    edit: async () => {},
    start: async () => {
      starts++;
    },
    stop: async () => {},
  }));
  const connecting = service.save({
    id: "shutdown",
    name: "Shutdown",
    provider: "telegram",
    enabled: true,
    credentials: { token: "fixture" },
  });
  await Bun.sleep(0);
  const stopping = service.stop();
  resolveIdentity({ id: "bot", name: "bot" });
  await Promise.all([connecting, stopping]);
  expect(starts).toBe(0);
  expect(service.list().find((c) => c.id === "shutdown")?.status).not.toBe("ready");
  db.close();
});
