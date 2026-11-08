import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacUpdater, selectMacRelease } from "./mac-updater.js";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function release(version: string, prerelease = false) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease,
    body: "Changes",
    assets: [
      {
        name: `orc-${version}-mac-arm64.dmg`,
        browser_download_url: `https://github.com/niradler/orc/releases/download/v${version}/orc-${version}-mac-arm64.dmg`,
        size: 7,
        digest: `sha256:${"a".repeat(64)}`,
      },
    ],
  };
}

test("should select a newer compatible release and respect stable and preview channels", () => {
  const releases = [
    release("0.2.0-beta.10", true),
    release("0.2.0-beta.2", true),
    release("0.1.62"),
  ];
  expect(selectMacRelease(releases, "0.1.61", false, "arm64")?.version).toBe("0.1.62");
  expect(selectMacRelease(releases, "0.1.61", true, "arm64")?.version).toBe("0.2.0-beta.10");
  expect(selectMacRelease(releases, "0.2.0", true, "arm64")).toBeNull();
  expect(selectMacRelease(releases, "0.1.61", false, "x64")).toBeNull();
  expect(() =>
    selectMacRelease(
      [
        {
          ...release("0.1.62"),
          assets: [
            {
              ...release("0.1.62").assets[0],
              browser_download_url: "https://evil.example/update.dmg",
            },
          ],
        },
      ],
      "0.1.61",
      false,
      "arm64",
    ),
  ).toThrow();
});

test("should download and verify a real payload before announcing restart readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "orc-mac-download-"));
  roots.push(root);
  const bytes = Buffer.from("payload");
  const item = release("0.1.62");
  const asset = item.assets[0];
  if (!asset) throw new Error("Missing fixture asset");
  asset.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(bytes) });
  servers.push(server);
  const updater = new MacUpdater({
    version: "0.1.61",
    arch: "arm64",
    cache: root,
    installedApp: "/Applications/orc.app",
    quit: () => {},
    fetch: (_url, options) => fetch(`${server.url}`, options),
    releases: async () => [item],
  });
  const events: string[] = [];
  updater.on("update-available", () => events.push("available"));
  updater.on("download-progress", () => events.push("progress"));
  updater.on("update-downloaded", () => events.push("downloaded"));
  await updater.checkForUpdates();
  expect(events[0]).toBe("available");
  expect(events.at(-1)).toBe("downloaded");
  expect(readFileSync(join(root, "update.dmg"))).toEqual(bytes);
  asset.digest = `sha256:${"a".repeat(64)}`;
  events.length = 0;
  await expect(updater.checkForUpdates()).rejects.toThrow("checksum");
  expect(events).not.toContain("downloaded");
  await expect(updater.prepareInstall()).rejects.toThrow("No verified");
});
