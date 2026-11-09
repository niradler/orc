import { expect, test } from "bun:test";
import { createJobOutputRedactor } from "./job-environment.js";

test("stream redaction preserves secrets across every chunk boundary, including overlaps and Unicode", () => {
  for (const [secrets, input, expected] of [
    [["secret-value"], "before secret-value after", "before [REDACTED] after"],
    [["abc", "bcd"], "before abcd after", "before [REDACTED] after"],
    [["prefix", "prefix-long"], "prefix-long tail", "[REDACTED] tail"],
    [["סוד🔐"], "before סוד🔐 after", "before [REDACTED] after"],
  ] as const) {
    for (let split = 0; split <= input.length; split++) {
      const redactor = createJobOutputRedactor([...secrets]);
      expect(
        redactor.write(input.slice(0, split)) +
          redactor.write(input.slice(split)) +
          redactor.finish(),
      ).toBe(expected);
    }
    const redactor = createJobOutputRedactor([...secrets]);
    expect([...input].map((chunk) => redactor.write(chunk)).join("") + redactor.finish()).toBe(
      expected,
    );
  }
});

test("redaction precedes rolling and capped retention, even for secrets longer than the output", () => {
  const secret = "SYNTHETIC_SECRET_BOUNDARY_12345";
  const output = createJobOutputRedactor([secret]);
  const safe =
    output.write(secret.slice(0, 20)) +
    output.write(secret.slice(20) + "x".repeat(63990)) +
    output.finish();
  expect(safe.slice(-64000)).not.toContain("DARY_12345");
  const longSecret = `${"s".repeat(65000)}END_SECRET`;
  const long = createJobOutputRedactor([longSecret]);
  expect(
    long.write(longSecret.slice(0, 64000)) + long.write(longSecret.slice(64000)) + long.finish(),
  ).toBe("[REDACTED]");
  const capped = createJobOutputRedactor([secret]);
  const value = capped.write("x".repeat(65530) + secret) + capped.finish();
  expect(value.slice(0, 65536)).toBe(`${"x".repeat(65530)}[REDAC`);
});

test("overlapping repeated secrets emit incrementally without retaining prior raw output", () => {
  const redactor = createJobOutputRedactor(["aa"]);
  expect(redactor.write("a".repeat(10000))).toBe("[REDACTED]");
  for (let i = 0; i < 100; i++) expect(redactor.write("a".repeat(1000))).toBe("");
  expect(redactor.write(" tail") + redactor.finish()).toBe(" tail");
});

test("safe stream chunks never split UTF-16 pairs before byte retention", () => {
  const redactor = createJobOutputRedactor(["longer-secret"]);
  const emitted = redactor.write("a🔐".repeat(10));
  const encoded = new TextDecoder().decode(new TextEncoder().encode(emitted));
  expect(encoded).toBe(emitted);
  expect(emitted + redactor.finish()).toBe("a🔐".repeat(10));
});
