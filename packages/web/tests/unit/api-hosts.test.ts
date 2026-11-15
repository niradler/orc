import { beforeEach, describe, expect, test } from "bun:test";
import {
  activeApiHost,
  apiHostError,
  apiHostWarning,
  deleteApiHost,
  hostHeaders,
  normalizeApiUrl,
  readActiveHostId,
  readApiHosts,
  readApiUrl,
  rememberApiHostSwitch,
  restorePreviousApiHost,
  sameApiUrl,
  saveApiHost,
  writeActiveHostId,
  writeApiUrl,
} from "../../src/lib/api-hosts";

const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

Object.assign(globalThis, {
  window: { location: { href: "http://localhost/" } } as unknown as Window,
  localStorage: storage,
});

const host = (headers: { name: string; value: string }[], token = "") => ({
  id: "host-1",
  label: "Work",
  url: "https://orc.example.com/api",
  token,
  headers,
});

beforeEach(() => store.clear());

describe("api hosts", () => {
  test("normalizes relative and absolute addresses for comparison", () => {
    expect(normalizeApiUrl("/api")).toBe("http://localhost/api");
    expect(normalizeApiUrl(" /api/ ")).toBe("http://localhost/api");
    expect(normalizeApiUrl("https://orc.example.com/api/")).toBe("https://orc.example.com/api");
    expect(normalizeApiUrl("")).toBe("http://localhost/api");
    expect(sameApiUrl("https://orc.example.com/api/", "https://orc.example.com/api")).toBe(true);
  });

  test("stores an address without a trailing slash so paths never double the separator", () => {
    writeApiUrl("https://orc.example.com/api//");
    expect(readApiUrl()).toBe("https://orc.example.com/api");
    const saved = saveApiHost({
      label: "",
      url: "https://orc.example.com/api/",
      token: "",
      headers: [],
    });
    expect(saved.url).toBe("https://orc.example.com/api");
    expect(saved.label).toBe("https://orc.example.com/api");
  });

  test("sends saved headers and replaces Authorization with the saved token", () => {
    expect(
      hostHeaders(
        host(
          [
            { name: "CF-Access-Client-Secret", value: "proxy" },
            { name: "Authorization", value: "Bearer stale" },
            { name: "X-Empty", value: "" },
          ],
          "fresh-jwt",
        ),
      ),
    ).toEqual({
      "CF-Access-Client-Secret": "proxy",
      Authorization: "Bearer fresh-jwt",
    });
  });

  test("keeps the dashboard's own request headers out of saved proxy headers", () => {
    expect(
      hostHeaders(
        host([
          { name: "Content-Type", value: "text/plain" },
          { name: "Accept", value: "text/html" },
          { name: "Cookie", value: "session=1" },
          { name: "X-Trace", value: "keep" },
        ]),
      ),
    ).toEqual({ "X-Trace": "keep" });
  });

  test("accepts relative paths and http(s) servers", () => {
    expect(apiHostError({ url: "/api", headers: [] })).toBeNull();
    expect(apiHostError({ url: "http://localhost:7701/api", headers: [] })).toBeNull();
    expect(apiHostError({ url: "https://orc.example.com/api", headers: [] })).toBeNull();
  });

  test("rejects missing, unsupported and malformed values", () => {
    expect(apiHostError({ url: "  ", headers: [] })).toContain("Enter the server URL");
    expect(apiHostError({ url: "ftp://orc.example.com", headers: [] })).toContain("http(s)");
    expect(apiHostError({ url: "/", headers: [] })).toContain("API path");
    expect(apiHostError({ url: "/api?x=1", headers: [] })).toContain("query string");
    expect(apiHostError({ url: "https://orc.example.com/api#top", headers: [] })).toContain(
      "query string",
    );
    expect(apiHostError({ url: "/api", headers: [{ name: "Bad Header", value: "x" }] })).toContain(
      "not a valid header name",
    );
    expect(apiHostError({ url: "/api", headers: [{ name: "", value: "x" }] })).toContain("name");
    expect(
      apiHostError({ url: "/api", headers: [{ name: "Content-Type", value: "text/plain" }] }),
    ).toContain("managed by this dashboard");
    expect(
      apiHostError({
        url: "/api",
        headers: [
          { name: "X-Test", value: "a" },
          { name: "x-test", value: "b" },
        ],
      }),
    ).toContain("listed twice");
    expect(apiHostError({ url: "/api", headers: [{ name: "X-Test", value: "a\nb" }] })).toContain(
      "line break",
    );
  });

  test("warns about plain-http remote addresses but not loopback", () => {
    expect(apiHostWarning({ url: "https://orc.example.com/api" })).toBeNull();
    expect(apiHostWarning({ url: "http://127.0.0.1:7701/api" })).toBeNull();
    expect(apiHostWarning({ url: "/api" })).toBeNull();
    expect(apiHostWarning({ url: "http://orc.example.com/api" })).toContain("unencrypted");
  });

  test("saves, switches and deletes a host", () => {
    const saved = saveApiHost({
      label: "Work",
      url: "https://orc.example.com/api",
      token: "jwt",
      headers: [
        { name: "CF-Access-Client-Id", value: "id" },
        { name: "Empty", value: "" },
      ],
    });
    expect(readApiHosts()).toHaveLength(1);
    expect(readApiHosts()[0]?.headers).toEqual([{ name: "CF-Access-Client-Id", value: "id" }]);

    writeApiUrl(saved.url);
    writeActiveHostId(saved.id);
    expect(activeApiHost()?.id).toBe(saved.id);
    // A stale id never selects a host at another address.
    writeApiUrl("https://other.example.com/api");
    expect(activeApiHost()).toBeUndefined();

    writeApiUrl(saved.url);
    expect(deleteApiHost(saved.id)).toBe(true);
    expect(readApiHosts()).toHaveLength(0);
    expect(readActiveHostId()).toBeNull();
  });

  test("restores the previous address and saved host after a switch", () => {
    const first = saveApiHost({
      label: "First",
      url: "https://first.example.com/api",
      token: "first-token",
      headers: [],
    });
    writeApiUrl(first.url);
    writeActiveHostId(first.id);

    rememberApiHostSwitch();
    writeApiUrl("https://second.example.com/api");
    writeActiveHostId("second");

    expect(restorePreviousApiHost()).toBe(first.url);
    expect(readApiUrl()).toBe(first.url);
    expect(readActiveHostId()).toBe(first.id);
  });

  test("ignores a host list it cannot read instead of throwing", () => {
    store.set("orc_api_hosts", "{not json");
    expect(readApiHosts()).toEqual([]);
    store.set("orc_api_hosts", JSON.stringify({ hosts: [] }));
    expect(readApiHosts()).toEqual([]);
    store.set(
      "orc_api_hosts",
      JSON.stringify([{ id: "one", url: "https://a.example.com/api" }, { label: "no id" }]),
    );
    expect(readApiHosts().map((saved) => saved.id)).toEqual(["one"]);
    expect(readApiHosts()[0]?.label).toBe("https://a.example.com/api");
  });
});
