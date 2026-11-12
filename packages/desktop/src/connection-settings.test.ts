import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConnectionDraft,
  localConnection,
  mergeHeaders,
  normalizeHeaders,
  normalizeServerUrl,
  normalizeToken,
  parseConnectionDraft,
  publicConnection,
  readConnectionSettings,
  requestOrigin,
  webOrigin,
  writeConnectionSettings,
} from "./connection-settings.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  directories.length = 0;
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "orc-desktop-connection-"));
  directories.push(directory);
  return join(directory, "connection.json");
}

test("should normalize a server address and reject non-server URLs", () => {
  expect(normalizeServerUrl(" https://orc.example.com/ ")).toBe("https://orc.example.com");
  expect(normalizeServerUrl("https://orc.example.com/api")).toBe("https://orc.example.com");
  expect(normalizeServerUrl("http://127.0.0.1:7700/orc/")).toBe("http://127.0.0.1:7700/orc");
  expect(() => normalizeServerUrl("orc.example.com")).toThrow("http:// or https://");
  expect(() => normalizeServerUrl("ftp://orc.example.com")).toThrow("http:// or https://");
  expect(() => normalizeServerUrl("https://user:pass@orc.example.com")).toThrow(
    "username or password",
  );
  expect(() => normalizeServerUrl("https://orc.example.com?token=1")).toThrow("query string");
});

test("should compare page and WebSocket URLs by the same HTTP origin", () => {
  expect(webOrigin("https://orc.example.com/settings?x=1")).toBe("https://orc.example.com");
  expect(webOrigin("wss://orc.example.com/api/terminals/ws")).toBe("https://orc.example.com");
  expect(webOrigin("ws://127.0.0.1:7700/api/terminals/ws")).toBe("http://127.0.0.1:7700");
  expect(webOrigin("file:///tmp/x")).toBeNull();
  expect(webOrigin("not a url")).toBeNull();
});

test("should scope request credentials to the initiating document", () => {
  expect(requestOrigin("https://orc.example.com", "https://orc.example.com/api/tasks")).toBe(
    "https://orc.example.com",
  );
  expect(requestOrigin("http://127.0.0.1:7700", "ws://127.0.0.1:7700/api/terminals/ws")).toBe(
    "http://127.0.0.1:7700",
  );
  // A remote page must not make the shell attach the local secret to its requests.
  expect(requestOrigin("https://orc.example.com", "http://127.0.0.1:7700/api/tasks")).toBeNull();
  // Top-level navigations have no initiator and need no credential.
  expect(requestOrigin(undefined, "http://127.0.0.1:7700/")).toBeNull();
  expect(requestOrigin("null", "http://127.0.0.1:7700/api/tasks")).toBeNull();
});

test("should validate custom headers without letting them replace managed ones", () => {
  expect(
    normalizeHeaders([
      { name: " CF-Access-Client-Id ", value: " id " },
      { name: "", value: "" },
    ]),
  ).toEqual([{ name: "CF-Access-Client-Id", value: "id" }]);
  expect(() => normalizeHeaders([{ name: "Bad Header", value: "x" }])).toThrow(
    "not a valid header name",
  );
  expect(() => normalizeHeaders([{ name: "Host", value: "example.com" }])).toThrow(
    "cannot be set here",
  );
  expect(() => normalizeHeaders([{ name: "Authorization", value: "Bearer x" }])).toThrow(
    "cannot be set here",
  );
  expect(() => normalizeHeaders([{ name: "Proxy-Authorization", value: "Basic x" }])).toThrow(
    "cannot be set here",
  );
  expect(() => normalizeHeaders([{ name: "Origin", value: "https://evil.example" }])).toThrow(
    "cannot be set here",
  );
  expect(() => normalizeHeaders([{ name: "X-Test", value: "a\nb" }])).toThrow(
    "line breaks or control characters",
  );
  expect(() =>
    normalizeHeaders([
      { name: "X-Test", value: "a" },
      { name: "x-test", value: "b" },
    ]),
  ).toThrow("listed twice");
  expect(() =>
    normalizeHeaders(
      Array.from({ length: 33 }, (_, index) => ({ name: `X-${index}`, value: "x" })),
    ),
  ).toThrow("at most 32");
  expect(() => normalizeToken("x".repeat(4097))).toThrow("too long");
  expect(() => normalizeToken("abc\ndef")).toThrow("invalid characters");
});

test("should reject an unknown connection mode from the preload bridge", () => {
  expect(() => parseConnectionDraft({ mode: "server" })).toThrow("local or a remote");
  expect(parseConnectionDraft({ mode: "remote", url: "https://orc.example.com" })).toMatchObject({
    mode: "remote",
    url: "https://orc.example.com",
  });
});

test("should replace a managed header regardless of the request's casing", () => {
  expect(
    mergeHeaders(
      { Authorization: "Bearer page-token", Accept: "application/json" },
      { authorization: "Bearer shell-token" },
    ),
  ).toEqual({ Accept: "application/json", authorization: "Bearer shell-token" });
});

test("should keep a saved token only while the server address is unchanged", () => {
  const current = {
    mode: "remote" as const,
    remote: {
      url: "https://orc.example.com",
      token: "saved-token",
      headers: [{ name: "CF-Access-Client-Id", value: "id" }],
    },
  };
  expect(
    applyConnectionDraft({ mode: "remote", url: "https://orc.example.com/", headers: [] }, current),
  ).toEqual({
    mode: "remote",
    remote: { url: "https://orc.example.com", token: "saved-token" },
  });
  expect(
    applyConnectionDraft(
      { mode: "remote", url: "https://other.example.com", headers: [] },
      current,
    ),
  ).toEqual({ mode: "remote", remote: { url: "https://other.example.com" } });
  expect(
    applyConnectionDraft(
      { mode: "remote", url: "https://orc.example.com", token: "new", headers: [] },
      current,
    ),
  ).toEqual({ mode: "remote", remote: { url: "https://orc.example.com", token: "new" } });
  expect(
    applyConnectionDraft(
      { mode: "remote", url: "https://orc.example.com", clear_token: true },
      current,
    ),
  ).toEqual({ mode: "remote", remote: { url: "https://orc.example.com" } });
  expect(applyConnectionDraft({ mode: "local" }, current)).toEqual({ ...current, mode: "local" });
});

test("should persist the selected server and not expose its token to a remote page", () => {
  const path = fixture();
  const settings = {
    mode: "remote" as const,
    remote: {
      url: "https://orc.example.com",
      token: "saved-token",
      headers: [{ name: "CF-Access-Client-Id", value: "id" }],
    },
  };
  writeConnectionSettings(path, settings);
  expect(readConnectionSettings(path)).toEqual(settings);
  expect(readFileSync(path, "utf8")).toContain('"token": "saved-token"');
  expect(publicConnection(settings, true)).toMatchObject({
    mode: "remote",
    url: "https://orc.example.com",
    has_token: true,
    editable: true,
  });
  expect(publicConnection(settings, false)).toMatchObject({
    mode: "remote",
    url: "https://orc.example.com",
    has_token: true,
    headers: [],
    editable: false,
  });
});

test("should fall back to the local server when the client file is damaged", () => {
  const path = fixture();
  writeConnectionSettings(path, { mode: "local" });
  expect(readConnectionSettings(path)).toEqual({ mode: "local" });
  writeFileSync(path, "{broken");
  expect(readConnectionSettings(path)).toEqual(localConnection());
  expect(readConnectionSettings(join(path, "..", "missing.json"))).toEqual(localConnection());
});
