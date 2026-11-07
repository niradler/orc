import { describe, expect, test } from "bun:test";
import { ChatSettingsSchema } from "@orc/core/chat";
import {
  agentEffort,
  agentModelLabel,
  branchChipLabel,
  branchName,
  currentWorktree,
  effectivePermissionMode,
  folderChipLabel,
  isWithin,
  pastedTextName,
  pathName,
  resolveAgentId,
  shouldAttachPaste,
  withPermissionMode,
} from "../../src/lib/composer-chips";

const defaults = ChatSettingsSchema.parse({});
const listing = {
  root: "/src/orc",
  worktrees: [
    { path: "/src/orc", branch: "refs/heads/master", head: "aaaaaaaa", main: true },
    { path: "/src/orc/.orc/worktrees/fix", branch: "orc/fix", head: "bbbbbbbb", main: false },
  ],
};

describe("pathName", () => {
  test("handles posix, windows and trailing separators", () => {
    expect(pathName("/local/projects/orc")).toBe("orc");
    expect(pathName("C:\\Projects\\orc\\")).toBe("orc");
    expect(pathName("/")).toBe("/");
    expect(pathName("C:\\")).toBe("C:");
  });
});

describe("worktree matching", () => {
  test("isWithin respects segment boundaries and drive-letter case", () => {
    expect(isWithin("/src/orc/packages", "/src/orc")).toBe(true);
    expect(isWithin("/src/orchestra", "/src/orc")).toBe(false);
    expect(isWithin("c:\\Projects\\ORC", "C:/projects/orc")).toBe(true);
  });
  test("currentWorktree picks the deepest match", () => {
    expect(currentWorktree(listing, "/src/orc/.orc/worktrees/fix/web")?.branch).toBe("orc/fix");
    expect(currentWorktree(listing, "/src/orc/packages")?.main).toBe(true);
    expect(currentWorktree(listing, "/elsewhere")).toBeUndefined();
  });
});

describe("folderChipLabel", () => {
  test("names the project, not the path", () => {
    expect(folderChipLabel("/src/orc", listing)).toBe("orc");
    expect(folderChipLabel("/src/orc/packages", listing)).toBe("orc/packages");
    expect(folderChipLabel("/src/orc/.orc/worktrees/fix", listing)).toBe("orc");
    expect(folderChipLabel("/tmp/scratch")).toBe("scratch");
    expect(folderChipLabel("")).toBe("Default folder");
  });
});

describe("branch labels", () => {
  test("branchName strips refs and falls back to a short head", () => {
    expect(branchName(listing.worktrees[0])).toBe("master");
    expect(branchName({ path: "/x", branch: null, head: "0123456789" })).toBe("0123456");
    expect(branchName(undefined)).toBeNull();
  });
  test("branchChipLabel shows the worktree base", () => {
    expect(branchChipLabel({ branch: "master", worktree: false })).toBe("master");
    expect(branchChipLabel({ branch: "master", worktree: true })).toBe("New worktree from master");
    expect(branchChipLabel({ branch: null, worktree: true })).toBe("New worktree");
    expect(branchChipLabel({ branch: null, worktree: false })).toBe("Branch");
  });
});

describe("permissions", () => {
  test("effective mode follows sdk, explicit and auto-approve settings", () => {
    expect(effectivePermissionMode({ ...defaults, agent: "codex" })).toBe("default");
    expect(effectivePermissionMode({ ...defaults, agent: "claude", autoApprove: true })).toBe(
      "bypassPermissions",
    );
    expect(effectivePermissionMode({ ...defaults, agent: "codex", autoApprove: true })).toBe(
      "acceptEdits",
    );
    expect(
      effectivePermissionMode({
        ...defaults,
        agent: "claude",
        permissionMode: "default",
        agentOptions: {
          claude: { runtime: "claude-sdk", options: { permissionMode: "acceptEdits" } },
        },
      }),
    ).toBe("acceptEdits");
  });
  test("withPermissionMode keeps sdk options in sync", () => {
    const config = {
      ...defaults,
      agent: "claude",
      agentOptions: {
        claude: {
          runtime: "claude-sdk" as const,
          options: { permissionMode: "acceptEdits" as const },
        },
      },
    };
    const next = withPermissionMode(config, "default");
    expect(next.permissionMode).toBe("default");
    expect(effectivePermissionMode(next)).toBe("default");
    expect(withPermissionMode({ ...defaults, agent: "codex" }, "acceptEdits").agentOptions).toEqual(
      defaults.agentOptions,
    );
  });
});

describe("agent and model", () => {
  test("agentEffort reads claude sdk and codex settings", () => {
    expect(agentEffort(defaults)).toBeNull();
    expect(
      agentEffort({
        ...defaults,
        agent: "claude",
        agentOptions: { claude: { runtime: "claude-sdk", options: { effort: "high" } } },
      }),
    ).toBe("High");
    expect(
      agentEffort({
        ...defaults,
        agent: "codex",
        agentOptions: {
          codex: { runtime: "codex", args: ["-c", 'model_reasoning_effort="xhigh"'] },
        },
      }),
    ).toBe("Extra high");
  });
  test("agentModelLabel joins model and effort", () => {
    expect(agentModelLabel("Opus 5.5", "High")).toBe("Opus 5.5 · High");
    expect(agentModelLabel("Default", null)).toBe("Default");
  });
  test("resolveAgentId maps session backends", () => {
    expect(resolveAgentId("claude")).toBe("claude");
    expect(resolveAgentId("cursor-agent")).toBe("cursor");
    expect(resolveAgentId("acpx")).toBeNull();
    expect(resolveAgentId("")).toBeNull();
  });
});

describe("long paste", () => {
  test("attaches large or many-line text only", () => {
    expect(shouldAttachPaste("short")).toBe(false);
    expect(shouldAttachPaste("x".repeat(16 * 1024))).toBe(true);
    expect(shouldAttachPaste("line\n".repeat(199))).toBe(true);
    expect(shouldAttachPaste("line\n".repeat(150))).toBe(false);
  });
  test("pastedTextName avoids existing names", () => {
    expect(pastedTextName([])).toBe("pasted-text-1.txt");
    expect(pastedTextName(["Pasted-Text-1.txt", "pasted-text-2.txt"])).toBe("pasted-text-3.txt");
  });
});
