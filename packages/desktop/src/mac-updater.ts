import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { launchMacInstall, prepareMacInstall } from "./mac-install.js";

type MacRelease = {
  version: string;
  releaseNotes: string;
  url: string;
  size: number;
  sha256: string;
};

function versionParts(version: string): { core: number[]; preview: string[] } {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version,
    );
  if (!match) throw new Error("Invalid release version");
  const core = match.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger)) throw new Error("Invalid release version");
  return { core, preview: match[4]?.split(".") ?? [] };
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < 3; i++) {
    const difference = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (difference) return difference;
  }
  if (!a.preview.length || !b.preview.length)
    return Number(!a.preview.length) - Number(!b.preview.length);
  for (let i = 0; i < Math.max(a.preview.length, b.preview.length); i++) {
    const x = a.preview[i];
    const y = b.preview[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return Number(x) - Number(y);
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function selectMacRelease(
  data: unknown,
  current: string,
  preview: boolean,
  arch: string,
): MacRelease | null {
  if (!Array.isArray(data)) throw new Error("Invalid release response");
  let selected: MacRelease | null = null;
  for (const entry of data) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid release response");
    const item = entry as Record<string, unknown>;
    if (item.draft || (!preview && item.prerelease)) continue;
    if (typeof item.tag_name !== "string") throw new Error("Missing release version");
    const version = item.tag_name.replace(/^v/, "");
    if (
      compareVersions(version, current) <= 0 ||
      (!preview && versionParts(version).preview.length)
    )
      continue;
    if (selected && compareVersions(version, selected.version) <= 0) continue;
    if (!Array.isArray(item.assets)) throw new Error("Missing release assets");
    const name = `orc-${version}-mac-${arch}.dmg`;
    const asset = item.assets.find((asset) => asset?.name === name);
    if (!asset) continue;
    const expected = `https://github.com/niradler/orc/releases/download/v${version}/${name}`;
    if (asset.browser_download_url !== expected) throw new Error("Invalid update download URL");
    if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 1024 ** 3)
      throw new Error("Invalid update size");
    if (typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest))
      throw new Error("Missing release checksum");
    selected = {
      version,
      releaseNotes: typeof item.body === "string" ? item.body.slice(0, 20_000) : "",
      url: expected,
      size: asset.size,
      sha256: asset.digest.slice(7),
    };
  }
  return selected;
}

export class MacUpdater extends EventEmitter {
  allowPrerelease = false;
  autoDownload = true;
  autoInstallOnAppQuit = false;
  private downloaded: MacRelease | null = null;
  private prepared: Awaited<ReturnType<typeof prepareMacInstall>> | null = null;

  constructor(
    private readonly options: {
      version: string;
      arch: string;
      cache: string;
      installedApp: string;
      quit: () => void;
      fetch?: (url: string, options?: RequestInit) => Promise<Response>;
      releases?: () => Promise<unknown>;
    },
  ) {
    super();
  }

  setFeedURL(): void {}

  installationError(): string | null {
    try {
      const result = readFileSync(
        join(
          dirname(this.options.installedApp),
          `.${basename(this.options.installedApp)}.orc-update/result`,
        ),
        "utf8",
      ).trim();
      return result === "error"
        ? "The last update could not be installed. Your previous app was retained. Check for updates to try again."
        : null;
    } catch {
      return null;
    }
  }

  async checkForUpdates(): Promise<void> {
    this.downloaded = null;
    this.prepared = null;
    const request = this.options.fetch ?? fetch;
    let data: unknown;
    if (this.options.releases) data = await this.options.releases();
    else {
      const response = await request(
        "https://api.github.com/repos/niradler/orc/releases?per_page=100",
        { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) },
      );
      if (!response.ok) throw new Error(`Release check failed (${response.status})`);
      data = await response.json();
    }
    const release = selectMacRelease(
      data,
      this.options.version,
      this.allowPrerelease,
      this.options.arch,
    );
    if (!release) {
      this.emit("update-not-available");
      return;
    }
    this.emit("update-available", release);
    await mkdir(this.options.cache, { recursive: true, mode: 0o700 });
    const temporary = join(this.options.cache, "update.partial");
    const destination = join(this.options.cache, "update.dmg");
    const hash = createHash("sha256");
    let received = 0;
    await rm(temporary, { force: true });
    try {
      const response = await request(release.url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body)
        throw new Error(`Update download failed (${response.status})`);
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            received += chunk.length;
            if (received > release.size) {
              callback(new Error("Update exceeds expected size"));
              return;
            }
            hash.update(chunk);
            this.emit("download-progress", { percent: (received / release.size) * 100 });
            callback(null, chunk);
          },
        }),
        createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
      );
      if (received !== release.size || hash.digest("hex") !== release.sha256)
        throw new Error("Update checksum mismatch");
      await rename(temporary, destination);
      this.downloaded = release;
      this.emit("update-downloaded", release);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async prepareInstall(): Promise<void> {
    if (!this.downloaded) throw new Error("No verified update is ready");
    this.prepared = await prepareMacInstall({
      installedApp: this.options.installedApp,
      image: join(this.options.cache, "update.dmg"),
      version: this.downloaded.version,
      sha256: this.downloaded.sha256,
      cache: this.options.cache,
    });
  }

  async quitAndInstall(): Promise<void> {
    if (!this.prepared) throw new Error("No verified update is prepared");
    await launchMacInstall(this.prepared);
    this.options.quit();
  }
}
