import { expect, test } from "bun:test";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { decryptCookie, safariCookies } from "./preview-store-import.js";

test("should authenticate Chromium GCM and host-bound CBC cookies, and reject corrupt/foreign/app-bound ciphertext", () => {
  const host = ".example.test",
    value = "synthetic-cookie",
    plain = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);
  const cbc = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1"),
    cipher = createCipheriv("aes-128-cbc", cbc, Buffer.alloc(16, 32));
  const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
  expect(decryptCookie(encrypted, host, 24, [cbc])).toBe(value);
  expect(decryptCookie(encrypted, "foreign.test", 24, [cbc])).toBeNull();
  expect(decryptCookie(encrypted, host, 24, [Buffer.alloc(16)])).toBeNull();
  const gcm = Buffer.alloc(32, 17),
    nonce = Buffer.alloc(12, 42),
    gcipher = createCipheriv("aes-256-gcm", gcm, nonce);
  const sealed = Buffer.concat([
    Buffer.from("v10"),
    nonce,
    gcipher.update(plain),
    gcipher.final(),
    gcipher.getAuthTag(),
  ]);
  expect(decryptCookie(sealed, host, 24, [gcm])).toBe(value);
  sealed.writeUInt8(sealed.readUInt8(sealed.length - 1) ^ 1, sealed.length - 1);
  expect(decryptCookie(sealed, host, 24, [gcm])).toBeNull();
  expect(
    decryptCookie(Buffer.concat([Buffer.from("v20"), encrypted.subarray(3)]), host, 24, [cbc, gcm]),
  ).toBeNull();
});

test("should preserve Safari host-only scope, secure/HttpOnly flags and expiry without widening SameSite", () => {
  const values = ["example.test", "demo", "/account", "synthetic-value"];
  const record = Buffer.alloc(
    56 + values.reduce((sum, value) => sum + Buffer.byteLength(value) + 1, 0),
  );
  record.writeUInt32LE(record.length, 0);
  record.writeUInt32LE(5, 8);
  record.writeDoubleLE(2000000000, 40);
  let offset = 56;
  values.forEach((value, index) => {
    record.writeUInt32LE(offset, 16 + index * 4);
    record.write(value, offset);
    offset += Buffer.byteLength(value) + 1;
  });
  const page = Buffer.alloc(16 + record.length);
  page.writeUInt32LE(1, 4);
  page.writeUInt32LE(16, 8);
  record.copy(page, 16);
  const file = Buffer.alloc(12 + page.length);
  file.write("cook");
  file.writeUInt32BE(1, 4);
  file.writeUInt32BE(page.length, 8);
  page.copy(file, 12);
  expect(safariCookies(file)).toEqual([
    {
      url: "https://example.test/account",
      name: "demo",
      value: "synthetic-value",
      path: "/account",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 2978307200,
    },
  ]);
  expect(() => safariCookies(file.subarray(0, file.length - 1))).toThrow();
  const corrupt = Buffer.from(file);
  corrupt.writeUInt32LE(8, 20);
  expect(() => safariCookies(corrupt)).toThrow();
  expect(() => safariCookies(Buffer.from("not cookies"))).toThrow();
});
