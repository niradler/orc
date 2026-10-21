import { expect, test } from "bun:test";
import { isLocalWebhookUrl, webhookFilters, webhookUrl } from "../../src/lib/webhook-setup";

test("webhook receiver follows the configured API origin instead of a separate dashboard", () => {
  expect(webhookUrl("token", "/api", "http://localhost:3077")).toBe(
    "http://localhost:3077/webhooks/token",
  );
  expect(webhookUrl("token", "https://orc.example.com/api", "http://localhost:3077")).toBe(
    "https://orc.example.com/webhooks/token",
  );
  expect(webhookUrl("token", "https://orc.example.com", "https://dashboard.example.com")).toBe(
    "https://orc.example.com/webhooks/token",
  );
  expect(isLocalWebhookUrl("http://localhost:3077/webhooks/token")).toBe(true);
  expect(isLocalWebhookUrl("http://[::1]:7701/webhooks/token")).toBe(true);
  expect(isLocalWebhookUrl("https://orc.example.com/webhooks/token")).toBe(false);
});

test("filters support all events and discard duplicate or empty entries", () => {
  expect(webhookFilters("  ")).toEqual([]);
  expect(webhookFilters("opened, synchronize,, opened ")).toEqual(["opened", "synchronize"]);
});
