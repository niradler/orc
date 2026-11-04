import { describe, expect, test } from "bun:test";
import { chatCommandNames, expandChatCommands } from "./chat-commands";

const prompts: Record<string, { content: string }> = {
  "create-task": { content: "Create a task.\nRequest: {{request}}" },
};
const skills: Record<string, string> = {
  tdd: "Write the test first.",
  "pkg/review": "Review carefully.",
};
const lookup = {
  prompt: (name: string) => prompts[name] ?? null,
  skill: (name: string) => skills[name] ?? null,
};

describe("chat commands", () => {
  test("finds tokens at the start or after whitespace, not inside paths", () => {
    expect(chatCommandNames("/tdd fix it /pkg/review\n/tdd")).toEqual(["tdd", "pkg/review"]);
    for (const text of ["hello/tdd", "see /api/x/", "//tdd", "/"])
      expect(chatCommandNames(text)).toEqual([]);
  });

  test("a leading prompt renders with the rest of the message as its request", () => {
    expect(expandChatCommands("/create-task fix login\nand logout", lookup)).toBe(
      "Create a task.\nRequest: fix login\nand logout",
    );
  });

  test("a prompt works in the middle of a message", () => {
    expect(expandChatCommands("please /create-task fix login", lookup)).toBe(
      "Create a task.\nRequest: please fix login",
    );
  });

  test("several skills anywhere in the message load ahead of it", () => {
    const out = expandChatCommands("fix the bug /tdd then /pkg/review", lookup);
    expect(out).toBe(
      [
        '<skill name="tdd">\nWrite the test first.\n</skill>',
        '<skill name="pkg/review">\nReview carefully.\n</skill>',
        "The user loaded the skills /tdd, /pkg/review above. Follow them for this message.",
        "fix the bug then",
      ].join("\n\n"),
    );
  });

  test("skills combine with a prompt", () => {
    expect(expandChatCommands("/tdd /create-task add login", lookup)).toBe(
      '<skill name="tdd">\nWrite the test first.\n</skill>\n\nCreate a task.\nRequest: add login',
    );
  });

  test("a skill on its own asks the agent to apply it", () => {
    expect(expandChatCommands("/tdd", lookup)).toContain("no further request");
  });

  test("unknown commands leave the message unchanged", () => {
    for (const text of ["/nope do it", "see /tmp now", "plain text"])
      expect(expandChatCommands(text, lookup)).toBe(text);
    expect(expandChatCommands("/nope and /tdd", lookup)).toEndWith("/nope and");
  });
});
