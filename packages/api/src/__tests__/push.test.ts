import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { HumanRequestStore } from "@orc/db/human-requests";
import { PushStore } from "@orc/db/push";
import webpush from "web-push";
import { notifyPendingAttention, type PushDeps, sendPush } from "../push/service.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(teardownTestApp);

// A real browser key pair so the payload encryption runs end to end.
const browserKeys = webpush.generateVAPIDKeys();
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/device-a",
  keys: { p256dh: browserKeys.publicKey, auth: Buffer.alloc(16, 7).toString("base64url") },
  label: "Phone",
  topics: ["attention", "chat"] as ("attention" | "chat")[],
};
const message = { title: "Hi", body: "There", url: "/", tag: "test" };

function deps(status: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const store = new PushStore(new Database(":memory:"));
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, deps: { store, fetch: fake } satisfies PushDeps };
}

test("should authenticate every push operation", async () => {
  for (const [method, path] of <[string, string][]>[
    ["GET", "/push/config"],
    ["GET", "/push/subscriptions"],
    ["POST", "/push/subscriptions"],
    ["PATCH", "/push/subscriptions/x"],
    ["DELETE", "/push/subscriptions/x"],
    ["POST", "/push/subscriptions/x/test"],
  ]) {
    const res = await app.request(`/api${path}`, { method });
    expect(res.status).toBe(401);
  }
});

test("should reject endpoints outside known push services", async () => {
  for (const endpoint of [
    "http://fcm.googleapis.com/x",
    "https://169.254.169.254/latest",
    "https://fcm.googleapis.com:8443/x",
    "https://user@fcm.googleapis.com/x",
    "https://evil.example/push.apple.com",
  ]) {
    const res = await req(app, "POST", "/push/subscriptions", { ...subscription, endpoint });
    expect(res.status).toBe(400);
  }
});

test("should manage push devices", async () => {
  const config = await (await req(app, "GET", "/push/config")).json();
  expect(config.public_key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  expect((await (await req(app, "GET", "/push/config")).json()).public_key).toBe(config.public_key);

  const created = await (await req(app, "POST", "/push/subscriptions", subscription)).json();
  expect(created).toMatchObject({ label: "Phone", topics: ["attention", "chat"] });
  expect(created).not.toHaveProperty("endpoint");

  const updated = await req(app, "PATCH", `/push/subscriptions/${created.id}`, {
    topics: ["chat"],
  });
  expect((await updated.json()).topics).toEqual(["chat"]);
  expect(await (await req(app, "GET", "/push/subscriptions")).json()).toHaveLength(1);

  expect((await req(app, "DELETE", `/push/subscriptions/${created.id}`)).status).toBe(204);
  expect((await req(app, "DELETE", `/push/subscriptions/${created.id}`)).status).toBe(404);
  expect((await req(app, "POST", `/push/subscriptions/${created.id}/test`)).status).toBe(404);
});

test("should send encrypted VAPID requests and record success", async () => {
  const { calls, deps: pushDeps } = deps(201);
  const device = pushDeps.store.subscribe({ ...subscription, topics: ["chat"] });
  expect(await sendPush("chat", message, undefined, pushDeps)).toEqual({
    sent: 1,
    failed: 0,
    expired: 0,
  });
  expect(await sendPush("attention", message, undefined, pushDeps)).toEqual({
    sent: 0,
    failed: 0,
    expired: 0,
  });
  expect(calls).toHaveLength(1);
  const headers = calls[0]?.init.headers as Record<string, string>;
  expect(calls[0]?.url).toBe(subscription.endpoint);
  expect(headers["Content-Encoding"]).toBe("aes128gcm");
  expect(headers.Authorization).toStartWith("vapid t=");
  expect(pushDeps.store.get(device.id).last_success_at).not.toBeNull();
});

test("should drop subscriptions the push service reports gone", async () => {
  const { deps: pushDeps } = deps(410);
  pushDeps.store.subscribe(subscription);
  expect(await sendPush("chat", message, undefined, pushDeps)).toMatchObject({ expired: 1 });
  expect(pushDeps.store.list()).toEqual([]);
});

test("should count transient failures without dropping the device", async () => {
  const { deps: pushDeps } = deps(500);
  const device = pushDeps.store.subscribe(subscription);
  expect(await sendPush("chat", message, undefined, pushDeps)).toMatchObject({ failed: 1 });
  expect(pushDeps.store.get(device.id).failure_count).toBe(1);
});

test("should push each pending attention request once per device", async () => {
  const { calls, deps: pushDeps } = deps(201);
  const humanRequests = new HumanRequestStore(pushDeps.store.db);
  pushDeps.store.subscribe(subscription);
  pushDeps.store.subscribe({
    ...subscription,
    endpoint: "https://fcm.googleapis.com/fcm/send/chat-only",
    topics: ["chat"],
  });
  humanRequests.create({
    kind: "question",
    prompt: "Ship it?",
    origin: { backend: "codex", session_id: "session-a", request_id: "request-a" },
  });
  await notifyPendingAttention(humanRequests, pushDeps);
  await notifyPendingAttention(humanRequests, pushDeps);
  expect(calls).toHaveLength(1);
});

test("should retry attention pushes after a transient failure", async () => {
  let status = 500;
  const store = new PushStore(new Database(":memory:"));
  let time = 1000;
  const humanRequests = new HumanRequestStore(store.db, () => time);
  let attempts = 0;
  const pushDeps: PushDeps = {
    store,
    fetch: (async () => {
      attempts++;
      return new Response(null, { status });
    }) as unknown as typeof fetch,
  };
  store.subscribe(subscription);
  humanRequests.create({
    kind: "question",
    prompt: "Which color?",
    origin: { backend: "codex", session_id: "session-b", request_id: "request-b" },
  });
  await notifyPendingAttention(humanRequests, pushDeps);
  await notifyPendingAttention(humanRequests, pushDeps);
  expect(attempts).toBe(1);
  status = 201;
  time += 31000;
  await notifyPendingAttention(humanRequests, pushDeps);
  await notifyPendingAttention(humanRequests, pushDeps);
  expect(attempts).toBe(2);
});
