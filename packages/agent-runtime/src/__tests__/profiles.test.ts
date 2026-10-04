import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAgent, getUserAgentsDir } from "@orc/core/agent-service";
import { createBackend, registerBackend } from "../index.js";
import {
  applyAgentProfile,
  openAgentSession,
  validateProfileCapabilities,
} from "../session-factory.js";
import type { AgentEvent, SessionOpts } from "../types.js";

describe("portable shared profiles", () => {
  const id = `runtime-profile-${process.pid}`;
  const restrictedId = `${id}-restricted`;
  afterAll(() => {
    for (const name of [id, restrictedId])
      rmSync(join(getUserAgentsDir(), `${name}.agent.md`), { force: true });
  });
  test("should send the same persona through two distinct coding backend adapters", async () => {
    createAgent(id, "---\ndescription: Shared reviewer\n---\nReview changes and cite evidence.");
    const prompts: string[] = [];
    const options: SessionOpts[] = [];
    for (const backendName of ["profile-backend-a", "profile-backend-b"]) {
      registerBackend(backendName, () => ({
        name: backendName,
        preflight: async () => ({ ok: true }),
        stop: async () => {},
        startSession: async (opts) => {
          options.push(opts);
          return {
            id: backendName,
            send: async (prompt) => {
              prompts.push(prompt);
            },
            respondPermission: () => {},
            events: async function* (): AsyncIterable<AgentEvent> {},
            alive: () => true,
            close: async () => {},
          };
        },
        resumeSession: async () => {
          throw new Error("No previous session");
        },
      }));
      const session = await openAgentSession(backendName, { cwd: process.cwd(), agentProfile: id });
      await session.send("Inspect this task");
    }
    expect(prompts).toHaveLength(2);
    expect(options).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]);
    expect(prompts[0]).toContain("Review changes and cite evidence.");
    expect(prompts[0]).toContain("Inspect this task");
  });
  test("should retain pinned model and enforce tools or refuse an incapable backend", async () => {
    const profile = createAgent(
      restrictedId,
      "---\ndescription: Read-only review\nmodel: pinned-model\ntools:\n  Read: true\n  Bash: false\n---\nRead only.",
    );
    const opts = applyAgentProfile({ cwd: process.cwd(), autoApprove: true }, profile);
    expect(opts.model).toBe("pinned-model");
    expect(opts.toolAllowlist).toEqual(["Read"]);
    expect(() => validateProfileCapabilities(createBackend("claude"), opts, profile)).not.toThrow();
    expect(() => validateProfileCapabilities(createBackend("codex-cli"), opts, profile)).toThrow(
      "tool whitelist",
    );
    await expect(
      openAgentSession("profile-backend-a", { cwd: process.cwd(), agentProfile: restrictedId }),
    ).rejects.toThrow("cannot honor profile model");
    await expect(
      openAgentSession("profile-backend-b", {
        cwd: process.cwd(),
        agentProfile: "missing-profile",
      }),
    ).rejects.toThrow("not found");
  });
});
