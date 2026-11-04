import { describe, expect, test } from "bun:test";
import { activeCommand, type CommandOption, rankCommands } from "../../src/lib/chat-commands";

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
