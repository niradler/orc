import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userHome } from "./home.js";

/**
 * Encryption at rest for secrets ORC stores in its own files (API keys in config, later the
 * settings table). AES-256-GCM with a per-machine key in ~/.orc/secret.key. Back that file up with
 * the config: without it, stored secrets cannot be read and must be entered again.
 */

const PREFIX = "enc:v1:";
const KEY_BYTES = 32;

export const secretKeyPath = () => join(userHome(), ".orc", "secret.key");

let cached: { path: string; key: Buffer } | null = null;

function secretKey(): Buffer {
  const path = secretKeyPath();
  if (cached?.path === path) return cached.key;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      // wx: when two processes race, the loser reads the winner's key instead of replacing it.
      writeFileSync(path, randomBytes(KEY_BYTES).toString("base64"), { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error(`${path} is not a valid ORC secret key`);
  cached = { path, key };
  return key;
}

export const isEncryptedSecret = (value: string) => value.startsWith(PREFIX);

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const b64 = (b: Buffer) => b.toString("base64url");
  return `${PREFIX}${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(data)}`;
}

/** Plain values (from environment variables or older configs) pass through unchanged. */
export function decryptSecret(value: string): string {
  if (!isEncryptedSecret(value)) return value;
  const [iv, tag, data] = value.slice(PREFIX.length).split(":");
  if (!iv || !tag || data === undefined) throw new Error("Malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
