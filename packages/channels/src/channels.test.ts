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
