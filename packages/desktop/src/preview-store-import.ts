// Cookie format handling adapted from T3 Code (MIT, copyright 2026 T3 Tools Inc.).
// See ../THIRD_PARTY_NOTICES.md. Secrets remain in this trusted process only.
import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { PreviewImportResult, PreviewImportSource } from "@orc/core/desktop-preview";
import type { CookiesSetDetails, Session } from "electron";
import { z } from "zod";

type Engine = "firefox" | "chromium" | "safari";
type Source = {
  id: string;
  name: string;
  root: string;
  file: string;
  engine: Engine;
  service?: string;
  account?: string;
  application?: string;
  identity: string;
};
export type StoreProfile = { id: string; name: string };
const run = promisify(execFile);
export function decryptCookie(
  encrypted: Buffer,
  host: string,
  version: number,
  keys: Buffer[],
): string | null {
  const prefix = encrypted.toString("ascii", 0, 3);
  if (prefix !== "v10" && prefix !== "v11") return null;
  for (const key of keys)
    try {
      let plain: Buffer;
      if (key.length === 32) {
        if (prefix !== "v10" || encrypted.length < 31) continue;
        const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(3, 15));
        decipher.setAuthTag(encrypted.subarray(-16));
        plain = Buffer.concat([decipher.update(encrypted.subarray(15, -16)), decipher.final()]);
      } else {
        const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
        plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
      }
      if (version >= 24) {
        if (!plain.subarray(0, 32).equals(createHash("sha256").update(host).digest())) continue;
        plain = plain.subarray(32);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(plain);
    } catch {
      /* Wrong/unsupported keys never yield fabricated cookie values. */
    }
  return null;
}
const firefoxRow = z.object({
  host: z.string().max(255),
  name: z.string().max(4096),
  value: z.string().max(65536),
  path: z.string().max(4096),
  expiry: z.number(),
  isSecure: z.number(),
  isHttpOnly: z.number(),
  sameSite: z.number().nullable(),
  rawSameSite: z.number().nullable(),
});
const chromiumRow = z.object({
  host_key: z.string().max(255),
  name: z.string().max(4096),
  value: z.string().max(65536),
  encrypted_value: z.instanceof(Uint8Array),
  path: z.string().max(4096),
  expires_utc: z.number(),
  is_secure: z.number(),
  is_httponly: z.number(),
  samesite: z.number(),
  partition_key: z.string(),
});
const domainName = (value: string) => value.replace(/^\./, "").toLowerCase();
const validDomain = (value: string) =>
  /^[a-z0-9.-]+$/i.test(value) && !value.includes("..") && value.length < 254;
const scope = (domain: string, path: string, secure: boolean) => ({
  url: `${secure ? "https" : "http"}://${domainName(domain)}${path.startsWith("/") ? path : "/"}`,
  ...(domain.startsWith(".") ? { domain } : {}),
});
const sameSite = (value: number | null): NonNullable<CookiesSetDetails["sameSite"]> =>
  value === 0 ? "no_restriction" : value === 1 ? "lax" : value === 2 ? "strict" : "unspecified";

async function identity(file: string, root: string): Promise<string> {
  const canonicalRoot = await realpath(root),
    canonical = await realpath(file);
  const inside = relative(canonicalRoot, canonical);
  if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`))
    throw new Error("Browser profile redirects outside its selected folder");
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64_000_000)
    throw new Error("Unsupported browser cookie store");
  return `${canonical}:${stat.dev}:${stat.ino}`;
}

async function snapshot<T>(source: Source, read: (db: DatabaseSync) => T): Promise<T> {
  if ((await identity(source.file, source.root)) !== source.identity)
    throw new Error("Source profile changed; scan profiles again");
  const folder = await mkdtemp(join(tmpdir(), "orc-cookie-import-"));
  let original: DatabaseSync | undefined, copy: DatabaseSync | undefined;
  try {
    original = new DatabaseSync(source.file, { readOnly: true });
    await backup(original, join(folder, "snapshot.sqlite"));
    await chmod(join(folder, "snapshot.sqlite"), 0o600);
    original.close();
    original = undefined;
    copy = new DatabaseSync(join(folder, "snapshot.sqlite"), { readOnly: true });
    return read(copy);
  } finally {
    copy?.close();
    original?.close();
    await rm(folder, { recursive: true, force: true });
  }
}

/** Read a Safari binary jar without accepting truncated/overlapping records. */
export function safariCookies(buffer: Buffer): CookiesSetDetails[] {
  const fail = () => new Error("Invalid Safari cookie store");
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "cook") throw fail();
  const pages = buffer.readUInt32BE(4);
  if (pages > 10000 || 8 + pages * 4 > buffer.length) throw fail();
  let start = 8 + pages * 4;
  const cookies: CookiesSetDetails[] = [];
  for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
    const size = buffer.readUInt32BE(8 + pageIndex * 4);
    if (size < 12 || start + size > buffer.length) throw fail();
    const page = buffer.subarray(start, start + size);
    start += size;
    const count = page.readUInt32LE(4),
      table = 12 + count * 4;
    if (count > 10000 || table > page.length) throw fail();
    const ranges: [number, number][] = [];
    for (let index = 0; index < count; index++) {
      const offset = page.readUInt32LE(8 + index * 4);
      if (offset < table || offset + 56 > page.length) throw fail();
      const length = page.readUInt32LE(offset),
        end = offset + length;
      if (length < 56 || end > page.length || ranges.some(([a, b]) => offset < b && end > a))
        throw fail();
      ranges.push([offset, end]);
      const record = page.subarray(offset, end);
      const string = (at: number) => {
        const pos = record.readUInt32LE(at);
        if (pos < 56 || pos >= record.length) throw fail();
        const end = record.indexOf(0, pos);
        if (end < 0) throw fail();
        return record.toString("utf8", pos, end);
      };
      const domain = string(16),
        name = string(20),
        path = string(24) || "/",
        value = string(28),
        flags = record.readUInt32LE(8),
        expiry = record.readDoubleLE(40);
      if (!validDomain(domainName(domain)) || !name || !Number.isFinite(expiry)) continue;
      cookies.push({
        ...scope(domain, path, !!(flags & 1)),
        name,
        value,
        path,
        secure: !!(flags & 1),
        httpOnly: !!(flags & 4),
        sameSite: "lax",
        ...(expiry > 0 ? { expirationDate: Math.floor(expiry) + 978307200 } : {}),
      });
      if (cookies.length > 10000) throw fail();
    }
  }
  const trailer = buffer.length - start;
  if (
    !(
      trailer === 0 ||
      trailer === 8 ||
      (trailer >= 12 && trailer === 12 + buffer.readUInt32BE(start + 8))
    )
  )
    throw fail();
  return cookies;
}

/** Native Settings-only grants. No file paths, encryption keys or cookie values cross the bridge. */
export class PreviewStoreImport {
  private sources = new Map<string, Source>();
  private selection: { source: Source; token: string; sites: string[]; until: number } | null =
    null;
  private generation = 0;
  cancel(): void {
    this.generation++;
    this.selection = null;
  }
  has(id: string): boolean {
    return this.selection?.token === id;
  }
  async list(): Promise<StoreProfile[]> {
    this.cancel();
    this.sources.clear();
    const home = homedir(),
      mac = process.platform === "darwin",
      win = process.platform === "win32";
    const definitions: {
      name: string;
      root: string;
      engine: Engine;
      service?: string;
      account?: string;
      application?: string;
    }[] = [
      {
        name: "Firefox",
        root: win
          ? join(process.env.APPDATA ?? home, "Mozilla/Firefox/Profiles")
          : mac
            ? join(home, "Library/Application Support/Firefox/Profiles")
            : join(home, ".mozilla/firefox"),
        engine: "firefox",
      },
      ...(!win
        ? [
            {
              name: "Chrome",
              root: mac
                ? join(home, "Library/Application Support/Google/Chrome")
                : join(home, ".config/google-chrome"),
              engine: "chromium" as const,
              service: "Chrome Safe Storage",
              account: "Chrome",
              application: "chrome",
            },
            {
              name: "Edge",
              root: mac
                ? join(home, "Library/Application Support/Microsoft Edge")
                : join(home, ".config/microsoft-edge"),
              engine: "chromium" as const,
              service: "Microsoft Edge Safe Storage",
              account: "Microsoft Edge",
              application: "msedge",
            },
            {
              name: "Brave",
              root: mac
                ? join(home, "Library/Application Support/BraveSoftware/Brave-Browser")
                : join(home, ".config/BraveSoftware/Brave-Browser"),
              engine: "chromium" as const,
              service: "Brave Safe Storage",
              account: "Brave",
              application: "brave",
            },
            {
              name: "Chromium",
              root: mac
                ? join(home, "Library/Application Support/Chromium")
                : join(home, ".config/chromium"),
              engine: "chromium" as const,
              service: "Chromium Safe Storage",
              account: "Chromium",
              application: "chromium",
            },
          ]
        : []),
      ...(mac
        ? [
            {
              name: "Safari",
              root: join(home, "Library/Containers/com.apple.Safari/Data/Library/Cookies"),
              engine: "safari" as const,
            },
          ]
        : []),
    ];
    const chromium = (
      name: string,
      macPath: string,
      linuxPath: string,
      service: string,
      account: string,
      application: string,
    ) => ({
      name,
      root: mac
        ? join(home, "Library/Application Support", macPath)
        : join(home, ".config", linuxPath),
      engine: "chromium" as const,
      service,
      account,
      application,
    });
    if (!win)
      definitions.push(
        chromium("Vivaldi", "Vivaldi", "vivaldi", "Vivaldi Safe Storage", "Vivaldi", "chrome"),
        chromium(
          "Opera",
          "com.operasoftware.Opera",
          "opera",
          "Opera Safe Storage",
          "Opera",
          "opera",
        ),
        chromium(
          "Helium",
          "net.imput.helium",
          "net.imput.helium",
          "Helium Storage Key",
          "Helium",
          "chromium",
        ),
      );
    else
      definitions.push({
        name: "Helium",
        root: join(process.env.LOCALAPPDATA ?? home, "imput/Helium/User Data"),
        engine: "chromium",
      });
    definitions.push({
      name: "Zen",
      root: win
        ? join(process.env.APPDATA ?? home, "zen/Profiles")
        : mac
          ? join(home, "Library/Application Support/zen/Profiles")
          : join(home, ".config/zen"),
      engine: "firefox",
    });
    if (process.platform === "linux")
      definitions.push(
        {
          name: "Firefox (Snap)",
          root: join(home, "snap/firefox/common/.mozilla/firefox"),
          engine: "firefox",
        },
        {
          name: "Firefox (Flatpak)",
          root: join(home, ".var/app/org.mozilla.firefox/.mozilla/firefox"),
          engine: "firefox",
        },
        { name: "Zen", root: join(home, ".zen"), engine: "firefox" },
        {
          name: "Zen (Flatpak)",
          root: join(home, ".var/app/app.zen_browser.zen/zen"),
          engine: "firefox",
        },
      );
    if (mac) {
      definitions.push(chromium("Arc", "Arc/User Data", "", "Arc Safe Storage", "Arc", ""));
      const stores = join(
        home,
        "Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteDataStore",
      );
      for (const id of (await readdir(stores).catch(() => [] as string[])).slice(0, 100))
        if (/^[a-f0-9-]{36}$/i.test(id))
          definitions.push({
            name: `Safari ${id}`,
            root: join(stores, id, "Cookies"),
            engine: "safari",
          });
    }
    for (const definition of definitions) {
      const directories =
        definition.engine === "safari"
          ? ["."]
          : [".", ...(await readdir(definition.root).catch(() => [] as string[]))];
      for (const directory of directories.slice(0, 100)) {
        const paths =
          definition.engine === "firefox"
            ? [join(directory, "cookies.sqlite")]
            : definition.engine === "safari"
              ? ["Cookies.binarycookies"]
              : [join(directory, "Network/Cookies"), join(directory, "Cookies")];
        for (const path of paths) {
          const file = resolve(definition.root, path);
          try {
            const fingerprint = await identity(file, definition.root),
              id = randomUUID();
            this.sources.set(id, {
              ...definition,
              id,
              file,
              identity: fingerprint,
              name: `${definition.name} · ${directory}`,
            });
            break;
          } catch {
            /* An absent/unreadable store is not an import grant. */
          }
        }
      }
    }
    return [...this.sources.values()].map(({ id, name }) => ({ id, name }));
  }
  async discover(id: string): Promise<PreviewImportSource> {
    this.cancel();
    const source = this.sources.get(id);
    if (!source) throw new Error("Scan browser profiles again");
    const generation = this.generation;
    let domains: string[];
    try {
      domains =
        source.engine === "safari"
          ? safariCookies(await readFile(source.file)).map((cookie) => new URL(cookie.url).hostname)
          : await snapshot(source, (db) => {
              const column = source.engine === "firefox" ? "host" : "host_key";
              const table = source.engine === "firefox" ? "moz_cookies" : "cookies";
              return db
                .prepare(`SELECT DISTINCT ${column} AS domain FROM ${table} LIMIT 1001`)
                .all()
                .map((row) => String(row.domain));
            });
    } catch {
      throw new Error(
        "Cookie store could not be read. Close the source browser and retry; Safari may need Full Disk Access in macOS Settings.",
      );
    }
    if (generation !== this.generation) throw new Error("Browser import cancelled");
    const sites = [...new Set(domains.map(domainName).filter(validDomain))]
      .slice(0, 1000)
      .map((domain) => `https://${domain}`);
    const token = randomUUID();
    this.selection = { source, token, sites, until: Date.now() + 300000 };
    return { id: token, name: source.name, sites };
  }
  private async keys(source: Source): Promise<Buffer[]> {
    if (process.platform === "win32") {
      const path = join(source.root, "Local State");
      if ((await lstat(path)).size > 1_000_000) throw new Error("Invalid browser key metadata");
      const state = z
        .object({
          os_crypt: z.object({
            encrypted_key: z.string().max(65536),
            app_bound_encrypted_key: z.string().optional(),
          }),
        })
        .parse(JSON.parse(await readFile(path, "utf8")));
      if (state.os_crypt.app_bound_encrypted_key !== undefined)
        throw new Error("Windows app-bound cookies require the live-browser connection");
      const wrapped = Buffer.from(state.os_crypt.encrypted_key, "base64");
      if (wrapped.subarray(0, 5).toString() !== "DPAPI") throw new Error("Unsupported Windows key");
      const secret = await new Promise<Buffer>((resolve, reject) => {
        const script =
          "Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$plain=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($plain))";
        const child = execFile(
          join(
            process.env.SystemRoot ?? "C:/Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            script,
          ],
          { timeout: 15000, maxBuffer: 65536, windowsHide: true },
          (error, stdout) => {
            if (error) {
              reject(new Error("Windows cookie key could not be read"));
              return;
            }
            resolve(Buffer.from(stdout, "base64"));
          },
        );
        child.stdin?.on("error", () => {});
        child.stdin?.end(wrapped.subarray(5).toString("base64"));
      });
      if (secret.length !== 32) {
        secret.fill(0);
        throw new Error("Invalid Windows cookie key");
      }
      return [secret];
    }
    if (process.platform === "darwin") {
      const { stdout } = await run(
        "/usr/bin/security",
        ["find-generic-password", "-w", "-s", source.service ?? "", "-a", source.account ?? ""],
        { timeout: 60000, maxBuffer: 65536 },
      );
      return [pbkdf2Sync(stdout.replace(/\r?\n$/, ""), "saltysalt", 1003, 16, "sha1")];
    }
    const keys = [
      pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1"),
      pbkdf2Sync("", "saltysalt", 1, 16, "sha1"),
    ];
    try {
      const { stdout } = await run(
        "secret-tool",
        ["lookup", "application", source.application ?? ""],
        { timeout: 30000, maxBuffer: 65536 },
      );
      if (stdout.trim())
        keys.unshift(pbkdf2Sync(stdout.replace(/\r?\n$/, ""), "saltysalt", 1, 16, "sha1"));
    } catch {
      /* v10 fallback remains available; v11 is reported as skipped. */
    }
    return keys;
  }
  async transfer(
    id: string,
    sites: string[],
    target: Pick<Session, "cookies">,
  ): Promise<PreviewImportResult> {
    const selection = this.selection;
    this.selection = null;
    if (
      !selection ||
      selection.token !== id ||
      selection.until < Date.now() ||
      !sites.length ||
      sites.some((site) => !selection.sites.includes(site))
    )
      throw new Error("Import selection expired; discover the profile again");
    const { source } = selection,
      generation = this.generation;
    if ((await identity(source.file, source.root)) !== source.identity)
      throw new Error("Source profile changed; scan again");
    const domains = sites.map((site) => new URL(site).hostname);
    let imported = 0,
      skipped = 0;
    try {
      let cookies: CookiesSetDetails[];
      if (source.engine === "safari") cookies = safariCookies(await readFile(source.file));
      else if (source.engine === "firefox")
        cookies = await snapshot(source, (db) => {
          const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
          const columns = new Set(
            db
              .prepare("PRAGMA table_info(moz_cookies)")
              .all()
              .map((row) => String(row.name)),
          );
          return db
            .prepare(
              `SELECT host,name,value,path,expiry,isSecure,isHttpOnly,${columns.has("sameSite") ? "sameSite" : "NULL AS sameSite"},${version >= 10 && version <= 14 && columns.has("rawSameSite") ? "rawSameSite" : "NULL AS rawSameSite"} FROM moz_cookies WHERE originAttributes='' AND (host IN (${domains.map(() => "?").join(",")}) OR host IN (${domains.map(() => "?").join(",")})) LIMIT 10001`,
            )
            .all(...domains, ...domains.map((domain) => `.${domain}`))
            .map((raw) => {
              const row = firefoxRow.parse(raw),
                secure = row.isSecure === 1,
                expiry = version >= 16 ? Math.floor(row.expiry / 1000) : row.expiry;
              return {
                ...scope(row.host, row.path, secure),
                name: row.name,
                value: row.value,
                path: row.path,
                secure,
                httpOnly: row.isHttpOnly === 1,
                sameSite:
                  row.sameSite === 1 && row.rawSameSite === 0
                    ? ("unspecified" as const)
                    : sameSite(row.sameSite),
                ...(expiry > 0 ? { expirationDate: expiry } : {}),
              };
            });
        });
      else {
        const keys = await this.keys(source);
        try {
          cookies = await snapshot(source, (db) => {
            const version = Number(
              db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value ?? 0,
            );
            const columns = new Set(
              db
                .prepare("PRAGMA table_info(cookies)")
                .all()
                .map((row) => String(row.name)),
            );
            const rows = db
              .prepare(
                `SELECT host_key,name,value,encrypted_value,path,CAST(expires_utc AS REAL) AS expires_utc,is_secure,is_httponly,samesite,${columns.has("top_frame_site_key") ? "top_frame_site_key" : "''"} AS partition_key FROM cookies WHERE host_key IN (${domains.map(() => "?").join(",")}) OR host_key IN (${domains.map(() => "?").join(",")}) LIMIT 10001`,
              )
              .all(...domains, ...domains.map((domain) => `.${domain}`));
            const result: CookiesSetDetails[] = [];
            for (const raw of rows) {
              const row = chromiumRow.parse(raw);
              if (row.partition_key) {
                skipped++;
                continue;
              }
              let value = row.value;
              if (row.encrypted_value.length) {
                const plain = decryptCookie(
                  Buffer.from(row.encrypted_value),
                  row.host_key,
                  version,
                  keys,
                );
                if (plain === null) {
                  skipped++;
                  continue;
                }
                value = plain;
              }
              const secure = row.is_secure === 1,
                expiry = row.expires_utc / 1000000 - 11644473600;
              result.push({
                ...scope(row.host_key, row.path, secure),
                name: row.name,
                value,
                path: row.path,
                secure,
                httpOnly: row.is_httponly === 1,
                sameSite: sameSite(row.samesite),
                ...(row.expires_utc > 0 ? { expirationDate: expiry } : {}),
              });
            }
            return result;
          });
        } finally {
          for (const key of keys) key.fill(0);
        }
      }
      if (cookies.length > 10000) throw new Error("Import too large; select fewer sites");
      for (const cookie of cookies) {
        if (generation !== this.generation) throw new Error("Import cancelled");
        if (
          !domains.includes(new URL(cookie.url).hostname) ||
          cookie.name?.toLowerCase() === "orc_session" ||
          (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000)
        ) {
          skipped++;
          continue;
        }
        try {
          await target.cookies.set(cookie);
          imported++;
        } catch {
          skipped++;
        }
      }
      if (generation !== this.generation) throw new Error("Browser import cancelled");
      await target.cookies.flushStore();
      if (generation !== this.generation) throw new Error("Browser import cancelled");
      return { imported, skipped };
    } catch {
      throw new Error(
        `Import incomplete (${imported} cookies written, ${skipped} skipped). Check source permissions or use the live-browser connection. Some sites require signing in again.`,
      );
    }
  }
}
