import { describe, expect, it } from "bun:test";
import { A2aSession } from "../a2a.js";

describe("A2aSession", () => {
  describe("URL validation", () => {
    it("accepts valid http URL", () => {
      const session = new A2aSession({ cwd: "/tmp", a2aUrl: "http://agent.example.com" });
      expect(session).toBeDefined();
    });

    it("accepts valid https URL", () => {
      const session = new A2aSession({
        cwd: "/tmp",
        a2aUrl: "https://agent.example.com:8080",
      });
      expect(session).toBeDefined();
    });

    it("rejects non-http protocols", () => {
      expect(() => new A2aSession({ cwd: "/tmp", a2aUrl: "file:///etc/passwd" })).toThrow(
        /must be http or https/,
      );
    });

    it("rejects empty URL", () => {
      expect(() => new A2aSession({ cwd: "/tmp", a2aUrl: "" })).toThrow(/a2aUrl is required/);
    });

    it("rejects missing URL", () => {
      expect(() => new A2aSession({ cwd: "/tmp" })).toThrow(/a2aUrl is required/);
    });

    it("rejects malformed URL", () => {
      expect(() => new A2aSession({ cwd: "/tmp", a2aUrl: "not-a-url" })).toThrow();
    });
  });
});
