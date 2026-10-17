import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfig } from "./config.js";
import { decryptSecret, encryptSecret, isEncryptedSecret, secretKeyPath } from "./secrets.js";

let home: string;
let cwd: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, dir: process.cwd() };

beforeEach(() => {
  // Never touch the real ~/.orc: the key file and config live under a temp home.
  home = mkdtempSync(join(tmpdir(), "orc-secrets-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  cwd = join(home, "work");
  mkdirSync(join(cwd, ".orc"), { recursive: true });
  process.chdir(cwd);
  resetConfig();
});

afterEach(() => {
  process.chdir(saved.dir);
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

describe("secrets", () => {
  test("round-trips through AES-GCM with a generated key file", () => {
    const enc = encryptSecret("sk-test-123");
    expect(isEncryptedSecret(enc)).toBe(true);
    expect(enc).not.toContain("sk-test-123");
    expect(encryptSecret("sk-test-123")).not.toBe(enc);
    expect(decryptSecret(enc)).toBe("sk-test-123");
    expect(secretKeyPath().startsWith(home)).toBe(true);
    expect(Buffer.from(readFileSync(secretKeyPath(), "utf8"), "base64")).toHaveLength(32);
    expect(decryptSecret("plain-from-env")).toBe("plain-from-env");
  });

  test("tampered ciphertext is refused", () => {
    const enc = encryptSecret("sk-test-123");
    const parts = enc.split(":");
    parts[4] = Buffer.from("other").toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  test("config load decrypts the embedding key; an unreadable one is dropped", () => {
    const write = (api_key: string) =>
      writeFileSync(
        join(cwd, ".orc", "config.json"),
        JSON.stringify({ knowledge: { embedding: { provider: "openai", api_key } } }),
      );
    write(encryptSecret("sk-live"));
    expect(loadConfig().knowledge.embedding.api_key).toBe("sk-live");
    write("enc:v1:AAAA:BBBB:CCCC");
    resetConfig();
    expect(loadConfig().knowledge.embedding.api_key).toBeUndefined();
  });
});
