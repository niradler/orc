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
});
