import { expect, test } from "bun:test";
import { loadConfig } from "@orc/core/config";
import { readAgentModelCatalog } from "../models";
import {
  providerSessionOptions,
  redactProviderEvent,
  withProviderRedaction,
} from "../provider-session";
import type { AgentSession } from "../types";

test("named providers isolate defaults and explicit session overrides", () => {
  const original = loadConfig();
  try {
    loadConfig({
      ...original,
      providers: {
        default_id: "work",
        instances: [
          {
            id: "work",
            name: "Work",
            agent: "claude",
            enabled: true,
            executable: "",
            model: "work-model",
            environment: [{ name: "AWS_PROFILE", value: "work", secret: false }],
            options: { runtime: "claude-sdk", options: { effort: "high" } },
          },
          {
            id: "personal",
            name: "Personal",
            agent: "claude",
            enabled: true,
            executable: "",
            model: "",
            environment: [],
          },
        ],
      },
    });
    expect(
      providerSessionOptions("claude", { cwd: process.cwd(), providerId: "work" }),
    ).toMatchObject({
      model: "work-model",
      env: { AWS_PROFILE: "work" },
      chatAgentOptions: { runtime: "claude-sdk", options: { effort: "high" } },
    });
    expect(providerSessionOptions("claude", { providerId: "personal" })).not.toHaveProperty(
      "chatAgentOptions",
    );
    expect(
      providerSessionOptions("claude", {
        providerId: "work",
        model: "",
        chatAgentOptions: { runtime: "claude-sdk", options: { effort: "low" } },
      }),
    ).toMatchObject({ model: "", chatAgentOptions: { options: { effort: "low" } } });
    expect(() => providerSessionOptions("codex-cli", { providerId: "work" })).toThrow(
      "does not match",
    );
    expect(() => providerSessionOptions("claude", { providerId: "missing" })).toThrow(
      "no longer configured",
    );
    const job = providerSessionOptions("claude", {
      providerId: "work",
      env: { AWS_PROFILE: "job-override" },
      redactOutput: (text: string) => text.replaceAll("job-secret", "[REDACTED]"),
    });
    expect(job.env.AWS_PROFILE).toBe("job-override");
    expect(job.redactOutput("error job-secret")).toBe("error [REDACTED]");
  } finally {
    loadConfig(original);
  }
});

test("model discovery forwards the configured environment into the actual child", async () => {
  const script = `if(process.env.AWS_PROFILE!=="fixture-profile"||process.env.ANTHROPIC_BASE_URL!=="http://127.0.0.1:4000")throw Error("Missing provider environment");for await(const chunk of Bun.stdin.stream()){const m=JSON.parse(new TextDecoder().decode(chunk));console.log(JSON.stringify({type:"control_response",response:{request_id:m.request_id,subtype:"success",response:{models:[{value:"fixture-model",displayName:"Fixture"}]}}}));}`;
  expect(
    await readAgentModelCatalog(
      "claude",
      { kind: "local" },
      [process.execPath, "-e", script],
      process.cwd(),
      { AWS_PROFILE: "fixture-profile", ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" },
    ),
  ).toEqual([{ id: "fixture-model", label: "Fixture" }]);
});

test("redacts credentials from persisted display payloads and thrown errors without changing routing IDs", async () => {
  const redact = (text: string) => text.replaceAll("x", "[REDACTED]");
  expect(
    redactProviderEvent(
      {
        type: "permission_request",
        data: { requestId: "x", tool: "exec", command: "echo x", input: { value: "x" } },
      },
      redact,
    ),
  ).toMatchObject({
    data: { requestId: "x", command: "echo [REDACTED]", input: { value: "[REDACTED]" } },
  });
  const session: AgentSession = {
    id: "x",
    send: async () => {
      throw Error("secret x");
    },
    respondPermission: () => {},
    alive: () => true,
    close: async () => {},
    async *events() {
      yield { type: "text", data: "x" };
      throw Error("stream x");
    },
  };
  const wrapped = withProviderRedaction(session, { cwd: process.cwd(), redactOutput: redact });
  expect(wrapped.id).toBe("x");
  await expect(wrapped.send("prompt")).rejects.toThrow("secret [REDACTED]");
  const events = wrapped.events()[Symbol.asyncIterator]();
  expect((await events.next()).value).toEqual({ type: "text", data: "[REDACTED]" });
  await expect(events.next()).rejects.toThrow("stream [REDACTED]");
});
