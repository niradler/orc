import { afterEach, describe, expect, test } from "bun:test";
import { HumanRequestInputSchema, HumanRespondPayloadSchema } from "./human-requests.js";
import {
  defaultProjectSecretName,
  formatProjectSecretRef,
  ProjectSecretCheckSchema,
  ProjectSecretNameSchema,
  parseProjectSecretRef,
} from "./project-secrets.js";
import {
  getRegisteredSecrets,
  redactRegisteredSecrets,
  registerRedactedSecrets,
  resetRedactedSecrets,
} from "./secret-redactor.js";

afterEach(() => {
  resetRedactedSecrets();
});

describe("secret request contracts", () => {
  const baseOrigin = { session_id: "sess-1", backend: "codex", request_id: "req-1" };

  test("accepts valid multi-field secret requests", () => {
    const parsed = HumanRequestInputSchema.parse({
      origin: baseOrigin,
      kind: "secret",
      title: "OpenAI credentials",
      prompt: "Provide API credentials for the integration check.",
      fields: [
        {
          key: "OPENAI_API_KEY",
          label: "OpenAI API key",
          description: "Project-scoped API key",
          required: true,
          link: "https://platform.openai.com/api-keys",
          reference_name: "openai-key",
        },
        {
          key: "BASE_URL",
          label: "Base URL",
          required: false,
          multiline: false,
        },
      ],
      save_to_project: true,
      notify: ["telegram"],
    });
    expect(parsed.kind).toBe("secret");
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.save_to_project).toBe(true);
  });

  test("rejects choices, duplicate keys, empty fields, and links with embedded credentials", () => {
    expect(
      HumanRequestInputSchema.safeParse({
        origin: baseOrigin,
        kind: "secret",
        prompt: "Missing fields",
      }).success,
    ).toBe(false);

    expect(
      HumanRequestInputSchema.safeParse({
        origin: baseOrigin,
        kind: "secret",
        prompt: "With choices",
        choices: ["a"],
        fields: [{ key: "TOKEN", label: "Token" }],
      }).success,
    ).toBe(false);

    expect(
      HumanRequestInputSchema.safeParse({
        origin: baseOrigin,
        kind: "secret",
        prompt: "Duplicate keys",
        fields: [
          { key: "TOKEN", label: "Token 1" },
          { key: "TOKEN", label: "Token 2" },
        ],
      }).success,
    ).toBe(false);

    expect(
      HumanRequestInputSchema.safeParse({
        origin: baseOrigin,
        kind: "secret",
        prompt: "Bad link",
        fields: [{ key: "TOKEN", label: "Token", link: "https://user:pass@example.com" }],
      }).success,
    ).toBe(false);

    expect(
      HumanRequestInputSchema.safeParse({
        origin: baseOrigin,
        kind: "question",
        prompt: "Question with fields",
        fields: [{ key: "TOKEN", label: "Token" }],
      }).success,
    ).toBe(false);
  });

  test("validates secret respond payloads", () => {
    const parsed = HumanRespondPayloadSchema.parse({
      kind: "secret",
      values: { OPENAI_API_KEY: "sk-test-value-1234" },
      save_to_project: true,
      reference_names: { OPENAI_API_KEY: "openai-key" },
    });
    expect(parsed.kind).toBe("secret");
  });
});

describe("project secret helpers and redactor", () => {
  test("parses and formats project secret references", () => {
    expect(ProjectSecretNameSchema.safeParse("openai-key").success).toBe(true);
    expect(ProjectSecretNameSchema.safeParse("OPENAI_API_KEY").success).toBe(true);
    expect(ProjectSecretNameSchema.safeParse("bad/name").success).toBe(false);
    expect(formatProjectSecretRef("openai-key")).toBe("project/openai-key");
    expect(parseProjectSecretRef("project/openai-key")).toBe("openai-key");
    expect(parseProjectSecretRef("plain-value")).toBeNull();
    expect(defaultProjectSecretName("OPENAI_API_KEY")).toBe("openai_api_key");
  });

  test("validates HTTP and command secret checks", () => {
    expect(
      ProjectSecretCheckSchema.safeParse({
        type: "http",
        url: "https://api.example.com/v1/models",
      }).success,
    ).toBe(true);
    expect(
      ProjectSecretCheckSchema.safeParse({
        type: "http",
        url: "https://user:secret@api.example.com/v1/models",
      }).success,
    ).toBe(false);
    expect(
      ProjectSecretCheckSchema.safeParse({
        type: "command",
        script: 'test -n "$ORC_SECRET_VALUE"',
      }).success,
    ).toBe(true);
  });

  test("redacts registered secrets across raw, url-encoded, base64, and json forms", () => {
    const value = "sk-top/secret+val=99";
    registerRedactedSecrets([value]);
    expect(getRegisteredSecrets().length).toBeGreaterThanOrEqual(3);
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const encoded = encodeURIComponent(value);
    const input = `raw=${value} url=${encoded} b64=${b64}`;
    const output = redactRegisteredSecrets(input);
    expect(output).not.toContain(value);
    expect(output).not.toContain(encoded);
    expect(output).not.toContain(b64);
    expect(output).toBe("raw=[REDACTED] url=[REDACTED] b64=[REDACTED]");
  });
});
