import { describe, expect, test } from "bun:test";
import {
  activeCommand,
  activeMention,
  type CommandOption,
  commandSegments,
  mentionToken,
  rankCommands,
} from "../../src/lib/chat-commands";

describe("chat command menu", () => {
  test("detects the command being typed at the caret anywhere in the draft", () => {
    expect(activeCommand("/kb", 3)).toEqual({ query: "kb", start: 0 });
    expect(activeCommand("fix it /td", 10)).toEqual({ query: "td", start: 7 });
    expect(activeCommand("/a done /", 9)).toEqual({ query: "", start: 8 });
    expect(activeCommand("use /pkg/rev", 12)).toEqual({ query: "pkg/rev", start: 4 });
    expect(activeCommand("/tdd then more", 14)).toBeNull();
    expect(activeCommand("a/b", 3)).toBeNull();
    expect(activeCommand("/td rest", 3)).toEqual({ query: "td", start: 0 });
  });

  test("ranks prefix matches before other matches", () => {
    const option = (name: string, description = ""): CommandOption => ({
      name,
      kind: "skill",
      title: "",
      description,
    });
    const options = [option("x-review"), option("review"), option("plan", "review a plan")];
    expect(rankCommands(options, "rev").map((o) => o.name)).toEqual(["review", "x-review", "plan"]);
    expect(rankCommands(options, "zzz")).toEqual([]);
  });
});

describe("command highlighting", () => {
  test("marks only known commands at word starts", () => {
    const names = new Set(["tdd", "pkg/review"]);
    expect(commandSegments("fix /tdd and /nope /pkg/review", names)).toEqual([
      { text: "fix ", command: false },
      { text: "/tdd", command: true },
      { text: " and /nope ", command: false },
      { text: "/pkg/review", command: true },
    ]);
    expect(commandSegments("a/tdd /tdd/x", names)).toEqual([
      { text: "a/tdd /tdd/x", command: false },
    ]);
    expect(commandSegments("", names)).toEqual([]);
  });

  test("detects the @ mention at the caret and splits its folder from the typed name", () => {
    expect(activeMention("@src/ap", 7)).toEqual({
      query: "src/ap",
      start: 0,
      folder: "src/",
      leaf: "ap",
    });
    expect(activeMention("read @", 6)).toEqual({ query: "", start: 5, folder: "", leaf: "" });
    expect(activeMention("mail me@example.com", 19)).toBeNull();
    expect(activeMention("@src/a.ts done", 14)).toBeNull();
    expect(activeCommand("@src/ap", 7)).toBeNull();
    expect(mentionToken("src/api.ts")).toBe("@src/api.ts");
    expect(mentionToken("My Docs/a.md")).toBe('@"My Docs/a.md"');
  });

  test("matches agent command aliases and fuzzy file names", () => {
    const review: CommandOption = {
      name: "code-review",
      kind: "agent",
      title: "",
      description: "Review the diff",
      aliases: ["review"],
    };
    expect(rankCommands([review], "rev")).toEqual([review]);
    const entry = (name: string, kind: "file" | "folder"): CommandOption => ({
      name,
      kind,
      title: "",
      description: "",
    });
    const files = [entry("api", "folder"), entry("app.tsx", "file"), entry("web", "folder")];
    expect(rankCommands(files, "ap").map((option) => option.name)).toEqual(["api", "app.tsx"]);
    expect(rankCommands(files, "atx").map((option) => option.name)).toEqual(["app.tsx"]);
    expect(rankCommands([review], "cdr")).toEqual([]);
  });
});
