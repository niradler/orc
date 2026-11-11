import { afterAll, expect, test } from "bun:test";
import type { CookiesSetDetails } from "electron";
import { PreviewImport } from "./preview-import.js";

let product = "Chrome/145.0",
  cookieReads = 0,
  stalled = false;
let sourceUrl = "https://example.test/account/settings",
  credentialsOnly = false;
const writes: CookiesSetDetails[] = [];
let flushed = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/json/version")
      return Response.json({
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/demo`,
      });
    if (server.upgrade(request)) return undefined;
    return new Response("Missing", { status: 404 });
  },
  websocket: {
    message(socket, raw) {
      const request = JSON.parse(String(raw));
      let result: object = {};
      if (request.method === "Browser.getVersion") result = { product, userAgent: "Demo Chromium" };
      if (request.method === "Target.getTargets")
        result = {
          targetInfos: [{ targetId: "source-page", type: "page", url: sourceUrl }],
        };
      if (request.method === "Target.attachToTarget") result = { sessionId: "scoped-page" };
      if (request.method === "Network.getCookies") {
        cookieReads++;
        if (stalled) return;
        result = credentialsOnly
          ? {
              cookies: [
                {
                  name: "orc_session",
                  value: "demo-only-orc",
                  domain: "127.0.0.1",
                  path: "/",
                  httpOnly: true,
                  secure: false,
                },
              ],
            }
          : {
              cookies: [
                {
                  name: "login",
                  value: "demo-only",
                  domain: "example.test",
                  path: "/account",
                  secure: true,
                  httpOnly: true,
                  sameSite: "Strict",
                  expires: Date.now() / 1000 + 3600,
                },
                {
                  name: "other",
                  value: "excluded",
                  domain: "unselected.test",
                  path: "/",
                  secure: true,
                  httpOnly: true,
                },
                {
                  name: "orc_session",
                  value: "must-never-transfer",
                  domain: "example.test",
                  path: "/",
                  secure: true,
                  httpOnly: true,
                },
                {
                  name: "partitioned",
                  value: "excluded",
                  domain: "example.test",
                  path: "/",
                  secure: true,
                  httpOnly: true,
                  partitionKey: { topLevelSite: "https://other.test" },
                },
              ],
            };
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    },
  },
});
afterAll(() => server.stop(true));
const jar = {
  cookies: {
    async set(cookie: CookiesSetDetails): Promise<void> {
      writes.push(cookie);
    },
    async flushStore(): Promise<void> {
      flushed = true;
    },
  },
};

test("should import selected cookie scope and flags, flush before success, and reject stale source identity before reading credentials", async () => {
  const importer = new PreviewImport("http://127.0.0.1:7702");
  const source = await importer.discover(server.port as number);
  expect(source.sites).toEqual(["https://example.test"]);
  const result = await importer.transfer(source.id, source.sites, jar);
  expect(result).toEqual({ imported: 1, skipped: 3 });
  expect(writes.some((cookie) => cookie.name === "orc_session")).toBe(false);
  expect(flushed).toBe(true);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    url: "https://example.test/account",
    path: "/account",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  });
  expect(writes[0]).not.toHaveProperty("domain");
  expect(JSON.stringify(result)).not.toContain("demo-only");
  await expect(importer.transfer(source.id, source.sites, jar)).rejects.toThrow(
    "expired or changed",
  );
  const changed = await importer.discover(server.port as number);
  const reads = cookieReads;
  product = "Chrome/146.0";
  await expect(importer.transfer(changed.id, changed.sites, jar)).rejects.toThrow(
    "did not complete",
  );
  expect(cookieReads).toBe(reads);
  product = "Chrome/145.0";
});

test("should never import ORC credentials through another service on the same hostname and different port", async () => {
  sourceUrl = "http://127.0.0.1:4000";
  credentialsOnly = true;
  const before = writes.length;
  try {
    const importer = new PreviewImport("http://127.0.0.1:7702");
    const source = await importer.discover(server.port as number);
    expect(await importer.transfer(source.id, source.sites, jar)).toEqual({
      imported: 0,
      skipped: 1,
    });
    expect(writes).toHaveLength(before);
  } finally {
    sourceUrl = "https://example.test/account/settings";
    credentialsOnly = false;
  }
});

test("should cancel an in-flight source connection without exposing its response or waiting for the timeout", async () => {
  const importer = new PreviewImport("http://127.0.0.1:7702");
  const source = await importer.discover(server.port as number);
  stalled = true;
  const before = cookieReads;
  const pending = importer.transfer(source.id, source.sites, jar);
  const observed = pending.then(
    () => null,
    (error: unknown) => error,
  );
  const deadline = Date.now() + 1000;
  while (cookieReads === before && Date.now() < deadline) await Bun.sleep(10);
  expect(cookieReads).toBe(before + 1);
  importer.cancel();
  const failure = await observed;
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", expect.stringContaining("did not complete"));
  stalled = false;
});
