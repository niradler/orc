import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyServerDraft,
  appMicrophoneAllowed,
  localConnection,
  mergeHeaders,
  normalizeHeaders,
  normalizeServerUrl,
  normalizeToken,
  parseServerDraft,
  publicConnection,
  readConnectionSettings,
  removeServer,
  requestOrigin,
  selectServer,
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

test("should keep only the draft fields the form owns from the preload bridge", () => {
  expect(() => parseServerDraft("x")).toThrow("Invalid server settings");
  expect(
    parseServerDraft({ id: "a", url: "https://orc.example.com", extra: 1, headers: [{ name: 1 }] }),
  ).toEqual({
    id: "a",
    label: "",
    url: "https://orc.example.com",
    token: "",
    clear_token: false,
    headers: [],
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

const work = {
  id: "work",
  label: "Work",
  url: "https://orc.example.com",
  token: "saved-token",
  headers: [{ name: "CF-Access-Client-Id", value: "id" }],
};

test("should keep a saved token only while the server address is unchanged", () => {
  const current = { active: "work", servers: [work] };
  const edit = (draft: object) =>
    applyServerDraft({ id: "work", label: "Work", headers: [], ...draft }, current).server;
  expect(edit({ url: "https://orc.example.com/" })).toEqual({
    id: "work",
    label: "Work",
    url: "https://orc.example.com",
    token: "saved-token",
  });
  expect(edit({ url: "https://other.example.com" }).token).toBeUndefined();
  expect(edit({ url: "https://orc.example.com", token: "new" }).token).toBe("new");
  expect(edit({ url: "https://orc.example.com", clear_token: true }).token).toBeUndefined();
  expect(() => applyServerDraft({ id: "gone", url: "https://x.example.com" }, current)).toThrow(
    "no longer saved",
  );
});

test("should save several servers, use one, and fall back to local when it is removed", () => {
  const first = applyServerDraft({ url: "https://a.example.com" }, localConnection());
  expect(first.server.label).toBe("a.example.com");
  expect(first.settings.active).toBe(first.server.id);
  const second = applyServerDraft({ label: "B", url: "https://b.example.com" }, first.settings);
  expect(second.settings.servers.map((server) => server.label)).toEqual(["a.example.com", "B"]);
  expect(second.settings.active).toBe(second.server.id);
  const renamed = applyServerDraft(
    { id: first.server.id, label: "A", url: "https://a.example.com" },
    second.settings,
  );
  expect(renamed.settings.active).toBe(second.server.id);
  const local = selectServer(renamed.settings, null);
  expect(local.active).toBeNull();
  const backToA = selectServer(local, first.server.id);
  expect(backToA.active).toBe(first.server.id);
  expect(() => selectServer(local, "missing")).toThrow("no longer saved");
  const removed = removeServer(backToA, first.server.id);
  expect(removed).toEqual({ active: null, servers: [second.server] });
});

test("should persist the list and not expose tokens or other servers to a remote page", () => {
  const path = fixture();
  const settings = {
    active: "work",
    servers: [work, { id: "b", label: "B", url: "https://b.example.com" }],
  };
  writeConnectionSettings(path, settings);
  expect(readConnectionSettings(path)).toEqual(settings);
  expect(readFileSync(path, "utf8")).toContain('"token": "saved-token"');
  expect(publicConnection(settings, true)).toMatchObject({
    mode: "remote",
    url: "https://orc.example.com",
    has_token: true,
    editable: true,
    active: "work",
    servers: [
      { id: "work", label: "Work", has_token: true, headers: work.headers },
      { id: "b", label: "B", has_token: false, headers: [] },
    ],
  });
  expect(JSON.stringify(publicConnection(settings, true))).not.toContain("saved-token");
  expect(publicConnection(settings, false)).toMatchObject({
    mode: "remote",
    url: "https://orc.example.com",
    has_token: true,
    headers: [],
    editable: false,
    servers: [],
  });
});

test("should migrate the single remote target saved by earlier versions", () => {
  const path = fixture();
  writeFileSync(
    path,
    JSON.stringify({ mode: "remote", remote: { url: "https://orc.example.com/api", token: "t" } }),
  );
  const migrated = readConnectionSettings(path);
  expect(migrated.servers).toMatchObject([
    { label: "orc.example.com", url: "https://orc.example.com", token: "t" },
  ]);
  expect(migrated.active).toBe(migrated.servers[0]?.id ?? "missing");
  writeFileSync(
    path,
    JSON.stringify({ mode: "local", remote: { url: "https://orc.example.com" } }),
  );
  expect(readConnectionSettings(path)).toMatchObject({
    active: null,
    servers: [{ label: "orc.example.com" }],
  });
});

test("should fall back to the local server when the client file is damaged", () => {
  const path = fixture();
  writeConnectionSettings(path, localConnection());
  expect(readConnectionSettings(path)).toEqual(localConnection());
  writeFileSync(path, JSON.stringify({ active: "gone", servers: [{ url: "nope" }, work] }));
  expect(readConnectionSettings(path)).toEqual({ active: null, servers: [work] });
  writeFileSync(path, "{broken");
  expect(readConnectionSettings(path)).toEqual(localConnection());
  expect(readConnectionSettings(join(path, "..", "missing.json"))).toEqual(localConnection());
});

test("only the app origin gets the microphone, and only for audio", () => {
  const app = "http://127.0.0.1:7700";
  expect(appMicrophoneAllowed("http://127.0.0.1:7700/tasks?chat=full", app, ["audio"])).toBe(true);
  expect(appMicrophoneAllowed("http://127.0.0.1:3000/", app, ["audio"])).toBe(false);
  expect(appMicrophoneAllowed("https://evil.example/", app, ["audio"])).toBe(false);
  expect(appMicrophoneAllowed("http://127.0.0.1:7700/", app, ["audio", "video"])).toBe(false);
  expect(appMicrophoneAllowed("http://127.0.0.1:7700/", app, ["video"])).toBe(false);
  expect(appMicrophoneAllowed("http://127.0.0.1:7700/", app, [])).toBe(false);
  expect(appMicrophoneAllowed("http://127.0.0.1:7700/", null, ["audio"])).toBe(false);
});
