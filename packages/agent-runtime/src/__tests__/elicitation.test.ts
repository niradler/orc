import { expect, test } from "bun:test";
import { elicitationForm } from "../elicitation.js";

test("should translate primitive MCP forms into real questions and typed native content", () => {
  const form = elicitationForm("request", {
    mode: "form",
    serverName: "tools",
    message: "Configure",
    requestedSchema: {
      type: "object",
      required: ["color", "count", "enabled"],
      properties: {
        color: { type: "string", enum: ["Blue", "Green"] },
        count: { type: "integer", minimum: 1, maximum: 3 },
        enabled: { type: "boolean" },
        note: { type: "string" },
      },
    },
  });
  expect(form.question.questions[0]?.options?.map((item) => item.label)).toEqual(["Blue", "Green"]);
  expect(
    form.content({ color: ["Blue"], count: ["2"], enabled: ["true"], note: ["(skip)"] }),
  ).toEqual({ color: "Blue", count: 2, enabled: true });
  expect(() => form.content({ color: ["Red"], count: ["2"], enabled: ["true"] })).toThrow();
  expect(() => form.content({ color: ["Blue"], count: ["4"], enabled: ["true"] })).toThrow();
});

test("should never put secret or URL authentication forms into durable questions", () => {
  expect(() => elicitationForm("r", { mode: "url", url: "https://example.com/auth" })).toThrow(
    "native client",
  );
  expect(() =>
    elicitationForm("r", {
      requestedSchema: { type: "object", properties: { password: { type: "string" } } },
    }),
  ).toThrow("Secret");
  expect(() =>
    elicitationForm("r", {
      requestedSchema: { type: "object", properties: { nested: { type: "object" } } },
    }),
  ).toThrow("unsupported");
});
