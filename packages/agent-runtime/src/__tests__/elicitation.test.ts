import { expect, test } from "bun:test";
import { acpElicitationForm, elicitationForm } from "../elicitation.js";

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

test("should map ACP single-select labels to their const values", () => {
  const form = acpElicitationForm("request", {
    mode: "form",
    message: "Choose a target",
    requestedSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: {
          type: "string",
          title: "Target",
          description: "Where should this run?",
          oneOf: [
            { const: "local-value", title: "This machine", description: "Run locally" },
            { const: "remote-value", title: "Remote host", description: "Run over SSH" },
          ],
        },
      },
    },
  });
  expect(form.question.questions[0]?.options?.map((option) => option.label)).toEqual([
    "This machine",
    "Remote host",
  ]);
  expect(form.content({ target: ["Remote host"] })).toEqual({ target: "remote-value" });
  expect(() => form.content({ target: ["Not an option"] })).toThrow("Invalid form answer");
  expect(() => form.content({})).toThrow("Missing form answer");
});

test("should convert ACP multi-select, free text and custom answers", () => {
  const form = acpElicitationForm("request", {
    mode: "form",
    message: "Configure",
    requestedSchema: {
      type: "object",
      required: ["colors", "note"],
      properties: {
        colors: {
          type: "array",
          title: "Colors",
          items: {
            anyOf: [
              { const: "red-value", title: "Red" },
              { const: "blue-value", title: "Blue" },
            ],
          },
          minItems: 1,
          maxItems: 2,
        },
        note: { type: "string", title: "Note", format: "email" },
        fruit: {
          type: "string",
          title: "Fruit",
          oneOf: [{ const: "apple-value", title: "Apple" }],
        },
        fruit_custom: {
          type: "string",
          title: "Fruit (other)",
          description: "Type your own answer",
        },
        count: { type: "integer", minimum: 1, maximum: 3 },
        enabled: { type: "boolean" },
      },
    },
  });
  expect(form.question.questions.find((question) => question.id === "colors")?.multiSelect).toBe(
    true,
  );
  expect(form.question.questions.some((question) => question.id === "fruit_custom")).toBe(false);
  expect(
    form.content({
      colors: ["Red", "Blue"],
      note: ["me@example.com"],
      fruit: ["Apple"],
      count: ["2"],
      enabled: ["false"],
    }),
  ).toEqual({
    colors: ["red-value", "blue-value"],
    note: "me@example.com",
    fruit: "apple-value",
    count: 2,
    enabled: false,
  });
  expect(
    form.content({
      colors: ["Red"],
      note: ["x"],
      fruit: ["Mango"],
      count: ["2"],
      enabled: ["true"],
    }),
  ).toEqual({
    colors: ["red-value"],
    note: "x",
    fruit: "Mango",
    fruit_custom: "Mango",
    count: 2,
    enabled: true,
  });
  expect(() =>
    form.content({
      colors: [],
      note: ["x"],
      fruit: ["Apple"],
      count: ["2"],
      enabled: ["true"],
    }),
  ).toThrow();
});

test("should decline unsupported ACP elicitation modes and schemas", () => {
  expect(() => acpElicitationForm("r", { mode: "url", message: "Sign in" })).toThrow(
    "native client",
  );
  expect(() => acpElicitationForm("r", { mode: "other", message: "Custom" })).toThrow(
    "native client",
  );
  expect(() =>
    acpElicitationForm("r", {
      mode: "form",
      message: "Unsupported",
      requestedSchema: { type: "object", properties: { value: { type: "external" } } },
    }),
  ).toThrow("Unsupported form field type");
  expect(() =>
    acpElicitationForm("r", {
      mode: "form",
      message: "Secret",
      requestedSchema: {
        type: "object",
        properties: { apiKey: { type: "string", title: "API key" } },
      },
    }),
  ).toThrow("Secret");
});
