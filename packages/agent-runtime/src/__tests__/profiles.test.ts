import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAgent, getUserAgentsDir } from "@orc/core/agent-service";
import { createBackend, registerBackend } from "../index.js";
import {
  applyAgentProfile,
  openAgentSession,
  validateProfileCapabilities,
} from "../session-factory.js";
import type { AgentEvent, AgentSession, SessionOpts } from "../types.js";

describe("portable shared profiles", () => {
  const id = `runtime-profile-${process.pid}`;
  const restrictedId = `${id}-restricted`;
  const persona = "Review changes and cite evidence.";
  beforeAll(() => {
    createAgent(id, `---\ndescription: Shared reviewer\n---\n${persona}`);
  });
  afterAll(() => {
    for (const name of [id, restrictedId])
      rmSync(join(getUserAgentsDir(), `${name}.agent.md`), { force: true });
  });

  // A recording session whose delivery declaration is configurable, so one fixture
  // can stand in for a prompt-rider, a system-slot agent, or an append-ignorer.
  function recordingBackend(
    name: string,
    declare: Partial<Pick<AgentSession, "systemPromptOnce" | "systemPromptSlot">>,
  ) {
    const prompts: string[] = [];
    const steers: string[] = [];
    const startOpts: SessionOpts[] = [];
    const resumeOpts: SessionOpts[] = [];
    const session = (): AgentSession => ({
      id: name,
      ...declare,
      send: async (prompt) => {
        prompts.push(prompt);
      },
      steer: async (prompt) => {
        steers.push(prompt);
      },
      respondPermission: () => {},
      events: async function* (): AsyncIterable<AgentEvent> {},
      alive: () => true,
      close: async () => {},
    });
    registerBackend(name, () => ({
      name,
      preflight: async () => ({ ok: true }),
      stop: async () => {},
      startSession: async (opts) => {
        startOpts.push(opts);
        return session();
      },
      resumeSession: async (_runtimeId, opts) => {
        resumeOpts.push(opts);
        return session();
      },
    }));
    return { prompts, steers, startOpts, resumeOpts };
  }

  test("should ride the append once for a prompt-riding session, not every prompt or steer", async () => {
    const name = `profile-rider-${process.pid}`;
    const backend = recordingBackend(name, { systemPromptOnce: true });
    const session = await openAgentSession(name, {
      cwd: process.cwd(),
      agentProfile: id,
      systemPromptAppend: "Caller instructions.",
    });
    await session.send("Inspect this task");
    await session.send("Follow up");
    await session.steer?.("Nudge");
    // The profile merges into the append the backend delivers once; the factory
    // adds no per-prompt concatenation of its own.
    expect(backend.startOpts[0]?.systemPromptAppend).toContain("Caller instructions.");
    expect(backend.startOpts[0]?.systemPromptAppend).toContain(persona);
    expect(backend.prompts).toEqual(["Inspect this task", "Follow up"]);
    expect(backend.steers).toEqual(["Nudge"]);
  });

  test("should ride the append for a system-slot session, leaving prompts bare", async () => {
    const name = `profile-slot-${process.pid}`;
    const backend = recordingBackend(name, { systemPromptSlot: true });
    const session = await openAgentSession(name, {
      cwd: process.cwd(),
      agentProfile: id,
    });
    await session.send("Inspect this task");
    await session.steer?.("Nudge");
    expect(backend.startOpts[0]?.systemPromptAppend).toContain(persona);
    expect(backend.prompts).toEqual(["Inspect this task"]);
    expect(backend.steers).toEqual(["Nudge"]);
  });

  test("should deliver the profile once in the prompt for an append-ignoring session", async () => {
    const name = `profile-ignorer-${process.pid}`;
    const backend = recordingBackend(name, {});
    const session = await openAgentSession(name, {
      cwd: process.cwd(),
      agentProfile: id,
    });
    await session.send("Inspect this task");
    await session.send("Follow up");
    await session.steer?.("Nudge");
    expect(backend.prompts[0]).toContain(persona);
    expect(backend.prompts[0]).toContain("Inspect this task");
    // Only the first prompt carries the profile; later sends and steers are bare.
    expect(backend.prompts[1]).toBe("Follow up");
    expect(backend.steers).toEqual(["Nudge"]);
  });

  test("should keep slash commands bare and still deliver the profile on the next real turn", async () => {
    const name = `profile-ignorer-cmd-${process.pid}`;
    const backend = recordingBackend(name, {});
    const session = await openAgentSession(name, {
      cwd: process.cwd(),
      agentProfile: id,
    });
    await session.send("/compact");
    await session.send("Inspect this task");
    expect(backend.prompts[0]).toBe("/compact");
    expect(backend.prompts[1]).toContain(persona);
  });

  test("should not re-deliver the profile on a confirmed resume of an append-ignoring session", async () => {
    const name = `profile-ignorer-resume-${process.pid}`;
    const backend = recordingBackend(name, {});
    const session = await openAgentSession(
      name,
      { cwd: process.cwd(), agentProfile: id, systemPromptDelivered: true },
      "native-fixture",
    );
    await session.send("Continue");
    expect(backend.resumeOpts[0]?.systemPromptDelivered).toBe(true);
    expect(backend.resumeOpts[0]?.systemPromptAppend).toContain(persona);
    expect(backend.prompts).toEqual(["Continue"]);
  });

  test("should reject an unsupported explicit session allowlist even without a profile", () => {
    expect(() =>
      validateProfileCapabilities(
        createBackend("codex-cli"),
        { cwd: process.cwd(), toolAllowlist: ["Read"] },
        null,
      ),
    ).toThrow("cannot enforce");
  });

  test("should retain pinned model and enforce tools or refuse an incapable backend", async () => {
    const profile = createAgent(
      restrictedId,
      "---\ndescription: Read-only review\nmodel: pinned-model\ntools:\n  Read: true\n  Bash: false\n---\nRead only.",
    );
    const opts = applyAgentProfile({ cwd: process.cwd(), autoApprove: true }, profile);
    expect(opts.model).toBe("pinned-model");
    expect(opts.toolAllowlist).toEqual(["Read"]);
    expect(
      applyAgentProfile({ cwd: process.cwd(), toolAllowlist: ["Grep", "Read"] }, profile)
        .toolAllowlist,
    ).toEqual(["Read"]);
    expect(
      applyAgentProfile({ cwd: process.cwd(), toolAllowlist: ["Grep"] }, profile).toolAllowlist,
    ).toEqual([]);
    expect(() => validateProfileCapabilities(createBackend("claude"), opts, profile)).not.toThrow();
    expect(() => validateProfileCapabilities(createBackend("codex-cli"), opts, profile)).toThrow(
      "tool whitelist",
    );
    const riderName = `profile-rider-${process.pid}`;
    await expect(
      openAgentSession(riderName, {
        cwd: process.cwd(),
        agentProfile: restrictedId,
      }),
    ).rejects.toThrow("cannot honor profile model");
    await expect(
      openAgentSession(riderName, {
        cwd: process.cwd(),
        agentProfile: "missing-profile",
      }),
    ).rejects.toThrow("not found");
  });
});
