import { describe, expect, test } from "bun:test";
import { CHAT_QUESTION_DISMISS_ANSWER, type ChatQuestion, chatAnswerText } from "./chat.js";

const question: ChatQuestion = {
  requestId: "question-1",
  questions: [
    {
      id: "color",
      header: "Color",
      question: "Choose a color",
      options: [{ label: "Blue", description: "Use blue" }],
    },
  ],
};

describe("chatAnswerText", () => {
  test("records one readable line per question", () => {
    expect(chatAnswerText(question, { color: ["Blue"] })).toBe("Choose a color: Blue");
    expect(
      chatAnswerText(
        {
          requestId: "question-2",
          questions: [
            ...question.questions,
            { id: "colors", header: "Colors", question: "Choose colors", multiSelect: true },
          ],
        },
        { color: ["Blue"], colors: ["Red", "Blue"] },
      ),
    ).toBe("Choose a color: Blue\nChoose colors: Red, Blue");
  });

  test("a secret answer never enters the transcript", () => {
    expect(
      chatAnswerText(
        {
          requestId: "question-3",
          questions: [{ id: "token", header: "Token", question: "API token", isSecret: true }],
        },
        { token: ["super-secret-value"] },
      ),
    ).toBe("API token: (hidden)");
  });

  test("a dismissal reads as the user's choice, not the agent instruction", () => {
    expect(chatAnswerText(question, { color: [CHAT_QUESTION_DISMISS_ANSWER] })).toBe(
      "Choose a color: (dismissed)",
    );
  });

  test("long or multiline questions stay a single clipped line", () => {
    const long = `${"word ".repeat(60)}end`;
    const text = chatAnswerText(
      {
        requestId: "question-4",
        questions: [{ id: "q", header: "Q", question: `First line\n${long}` }],
      },
      { q: ["yes"] },
    );
    expect(text.startsWith("First line ")).toBe(true);
    expect(text.endsWith(": yes")).toBe(true);
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual(200 + ": yes".length);
  });
});
