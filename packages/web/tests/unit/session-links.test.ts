import { describe, expect, test } from "bun:test";
import { sessionPath } from "../../src/lib/session-links";

describe("session notification paths", () => {
  test("should keep links that already point at the chat page", () => {
    expect(sessionPath("/chat?sessionView=abc")).toBe("/chat?sessionView=abc");
    expect(sessionPath("/chat?sessionList=show")).toBe("/chat?sessionList=show");
    expect(sessionPath("/tasks/42")).toBe("/tasks/42");
  });

  test("should move a stored /sessions link into the chat", () => {
    expect(sessionPath("/sessions?session=demo-live-3")).toBe("/chat?sessionLive=demo-live-3");
    expect(sessionPath("/sessions?project=acme&session=demo-live-3")).toBe(
      "/chat?project=acme&sessionLive=demo-live-3",
    );
  });

  test("should open a stored side-chat link on the chat page", () => {
    expect(sessionPath("/activity?chat=open&chatThread=t-1&project=acme")).toBe(
      "/chat?chatThread=t-1&project=acme",
    );
    expect(sessionPath("/?chat=open&chatThread=t-1")).toBe("/chat?chatThread=t-1&project=all");
  });

  test("should open the session list when the old link named no session", () => {
    expect(sessionPath("/sessions")).toBe("/chat?sessionList=show");
    expect(sessionPath("/sessions?project=acme")).toBe("/chat?project=acme&sessionList=show");
  });
});
