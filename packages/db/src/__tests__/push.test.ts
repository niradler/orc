import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { PushStore } from "../push.js";

function fixture() {
  let time = 1000;
  return {
    store: new PushStore(new Database(":memory:"), () => time),
    advance: () => {
      time += 1000;
    },
  };
}
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/device-a",
  keys: { p256dh: "BPublicKey", auth: "secret" },
  label: "Phone",
  topics: ["attention", "chat"] as ("attention" | "chat")[],
};

test("should generate VAPID keys once and reuse them", () => {
  const { store } = fixture();
  let generated = 0;
  const generate = () => {
    generated++;
    return { publicKey: `public-${generated}`, privateKey: `private-${generated}` };
  };
  expect(store.vapidKeys(generate)).toEqual({ publicKey: "public-1", privateKey: "private-1" });
  expect(store.vapidKeys(generate)).toEqual({ publicKey: "public-1", privateKey: "private-1" });
  expect(generated).toBe(1);
});

test("should refresh a device that re-subscribes with the same endpoint", () => {
  const { store } = fixture();
  const first = store.subscribe(subscription);
  store.markFailed(first.id);
  const second = store.subscribe({ ...subscription, label: "Tablet", topics: ["chat"] });
  expect(second.id).toBe(first.id);
  expect(second).toMatchObject({
    label: "Tablet",
    topics: ["chat"],
    failure_count: 0,
    endpoint_host: "fcm.googleapis.com",
  });
  expect(store.list()).toHaveLength(1);
});

test("should keep a device's topics when it re-subscribes without choosing", () => {
  const { store } = fixture();
  const { topics: _, ...resubscribe } = subscription;
  const device = store.subscribe(resubscribe);
  expect(device.topics).toEqual(["attention", "chat"]);
  store.updateTopics(device.id, ["chat"]);
  expect(store.subscribe({ ...resubscribe, label: "Phone 2" })).toMatchObject({
    id: device.id,
    topics: ["chat"],
    label: "Phone 2",
  });
});

test("should target devices by topic or id", () => {
  const { store } = fixture();
  const phone = store.subscribe(subscription);
  const tablet = store.subscribe({
    ...subscription,
    endpoint: "https://fcm.googleapis.com/fcm/send/device-b",
    topics: ["chat"],
  });
  expect(store.targets("attention").map((target) => target.id)).toEqual([phone.id]);
  expect(store.targets("chat")).toHaveLength(2);
  expect(store.targets(null, tablet.id)).toEqual([
    {
      id: tablet.id,
      endpoint: "https://fcm.googleapis.com/fcm/send/device-b",
      keys: { p256dh: "BPublicKey", auth: "secret" },
    },
  ]);
});

test("should track delivery outcomes and expiry", () => {
  const { store, advance } = fixture();
  const device = store.subscribe(subscription);
  store.markFailed(device.id);
  expect(store.get(device.id).failure_count).toBe(1);
  advance();
  store.markDelivered(device.id);
  expect(store.get(device.id)).toMatchObject({ failure_count: 0, last_success_at: 2000 });
  store.expire(device.id);
  expect(store.list()).toEqual([]);
});

test("should update topics and reject unknown devices", () => {
  const { store } = fixture();
  const device = store.subscribe(subscription);
  expect(store.updateTopics(device.id, ["attention", "attention"]).topics).toEqual(["attention"]);
  expect(() => store.updateTopics("missing", [])).toThrow("Push device not found");
  expect(() => store.remove("missing")).toThrow("Push device not found");
  store.remove(device.id);
  expect(() => store.get(device.id)).toThrow("Push device not found");
});
