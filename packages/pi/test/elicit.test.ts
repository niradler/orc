import { describe, expect, test } from "bun:test";
import { uiElicitation } from "../src/elicit.js";

function ui(answers: {
  select?: (string | undefined)[];
  input?: (string | undefined)[];
  confirm?: boolean[];
}) {
  const selects = [...(answers.select ?? [])];
  const inputs = [...(answers.input ?? [])];
  const confirms = [...(answers.confirm ?? [])];
  const prompts: string[] = [];
  return {
    prompts,
    select: async (title: string) => {
      prompts.push(title);
      return selects.shift();
    },
    input: async (title: string) => {
      prompts.push(title);
      return inputs.shift();
    },
    confirm: async (title: string, message: string) => {
      prompts.push(`${title}: ${message}`);
      return confirms.shift() ?? false;
    },
  };
}

describe("uiElicitation", () => {
  test("uses a select for enums and coerces numbers", async () => {
    const fake = ui({ select: ["blue"], input: ["42"] });
    const handler = uiElicitation(fake);
    const result = await handler({
      message: "Configure",
      requestedSchema: {
        type: "object",
        properties: {
          color: { type: "string", enum: ["red", "blue"] },
          count: { type: "integer" },
        },
        required: ["color", "count"],
      },
    });
    expect(result).toEqual({ action: "accept", content: { color: "blue", count: 42 } });
    expect(fake.prompts).toEqual(["Configure — color", "Configure — count"]);
  });

  test("booleans use the schema type", async () => {
    const handler = uiElicitation(ui({ input: ["yes"] }));
    const result = await handler({
      message: "Confirm",
      requestedSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    });
    expect(result.content).toEqual({ ok: true });
  });

  test("cancels when a prompt is dismissed", async () => {
    const handler = uiElicitation(ui({ input: [undefined] }));
    const result = await handler({
      message: "Name?",
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
    });
    expect(result).toEqual({ action: "cancel" });
  });

  test("a schema with no fields asks for confirmation", async () => {
    const accepted = uiElicitation(ui({ confirm: [true] }));
    expect(await accepted({ message: "Proceed?", requestedSchema: {} })).toEqual({
      action: "accept",
      content: {},
    });
    const declined = uiElicitation(ui({ confirm: [false] }));
    expect(await declined({ message: "Proceed?", requestedSchema: {} })).toEqual({
      action: "decline",
    });
  });

  test("declines secret fields without prompting and handles oneOf choices and invalid numbers", async () => {
    const secretUi = ui({ input: ["should-not-be-read"] });
    const secretHandler = uiElicitation(secretUi);
    expect(
      await secretHandler({
        message: "Auth",
        requestedSchema: {
          type: "object",
          properties: { api_key: { type: "string" } },
        },
      }),
    ).toEqual({ action: "decline" });
    expect(secretUi.prompts).toEqual([]);

    const oneOfHandler = uiElicitation(ui({ select: ["Production"] }));
    expect(
      await oneOfHandler({
        message: "Target",
        requestedSchema: {
          type: "object",
          properties: {
            env: {
              type: "string",
              oneOf: [
                { const: "staging", title: "Staging" },
                { const: "prod", title: "Production" },
              ],
            },
          },
        },
      }),
    ).toEqual({ action: "accept", content: { env: "prod" } });

    const badNumHandler = uiElicitation(ui({ input: ["not-a-number"] }));
    expect(
      await badNumHandler({
        message: "Count",
        requestedSchema: {
          type: "object",
          properties: { count: { type: "integer" } },
        },
      }),
    ).toEqual({ action: "decline" });

    const boundedHandler = uiElicitation(ui({ input: ["0"] }));
    expect(
      await boundedHandler({
        message: "Count",
        requestedSchema: {
          type: "object",
          properties: { count: { type: "integer", minimum: 1 } },
          required: ["count"],
        },
      }),
    ).toEqual({ action: "decline" });

    const optionalBlankHandler = uiElicitation(ui({ input: ["Ada", ""] }));
    expect(
      await optionalBlankHandler({
        message: "Profile",
        requestedSchema: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            age: { type: "integer" },
          },
          required: ["name"],
        },
      }),
    ).toEqual({ action: "accept", content: { name: "Ada" } });

    const nestedSecretUi = ui({ input: ["nope"] });
    const nestedSecretHandler = uiElicitation(nestedSecretUi);
    expect(
      await nestedSecretHandler({
        message: "Nested",
        requestedSchema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "string", format: "password" } },
          },
        },
      }),
    ).toEqual({ action: "decline" });
    expect(nestedSecretUi.prompts).toEqual([]);

    const unionSecretUi = ui({ input: ["nope"] });
    const unionSecretHandler = uiElicitation(unionSecretUi);
    expect(
      await unionSecretHandler({
        message: "Union secret",
        requestedSchema: {
          type: "object",
          properties: {
            field: { anyOf: [null as unknown as Record<string, unknown>, { writeOnly: true }] },
          },
        },
      }),
    ).toEqual({ action: "decline" });
    expect(unionSecretUi.prompts).toEqual([]);

    const nullUnionHandler = uiElicitation(ui({ select: ["b"] }));
    expect(
      await nullUnionHandler({
        message: "Malformed union",
        requestedSchema: {
          type: "object",
          properties: {
            env: { oneOf: [null as unknown as Record<string, unknown>, { const: "b" }] },
          },
        },
      }),
    ).toEqual({ action: "accept", content: { env: "b" } });
  });
});
