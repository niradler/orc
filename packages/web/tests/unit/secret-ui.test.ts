import { describe, expect, test } from "bun:test";
import {
  formatSecretLastUsed,
  initialSecretReferenceNames,
  secretAutocompleteHint,
} from "../../src/lib/secret-ui.ts";

describe("secret UI helpers", () => {
  test("infers password-manager friendly autocomplete hints", () => {
    expect(
      secretAutocompleteHint({ key: "OPENAI_API_KEY", label: "OpenAI API key", multiline: false }),
    ).toBe("current-password");
    expect(secretAutocompleteHint({ key: "BASE_URL", label: "Base URL", multiline: false })).toBe(
      "url",
    );
    expect(
      secretAutocompleteHint({ key: "USERNAME", label: "Account username", multiline: false }),
    ).toBe("username");
    expect(
      secretAutocompleteHint({ key: "OTP_CODE", label: "Verification code", multiline: false }),
    ).toBe("one-time-code");
    expect(secretAutocompleteHint({ key: "PRIVATE_KEY", label: "PEM key", multiline: true })).toBe(
      "off",
    );
  });

  test("generates unique initial project secret reference names", () => {
    const names = initialSecretReferenceNames([
      {
        key: "OPENAI_API_KEY",
        label: "OpenAI API key",
        required: true,
        multiline: false,
        reference_name: "openai-key",
      },
      {
        key: "BASE_URL",
        label: "Base URL",
        required: true,
        multiline: false,
      },
    ]);
    expect(names).toEqual({
      OPENAI_API_KEY: "openai-key",
      BASE_URL: "base_url",
    });
  });

  test("formats last used timestamps safely", () => {
    expect(formatSecretLastUsed(null)).toBe("Never used");
    expect(formatSecretLastUsed("not-a-date")).toBe("Never used");
    expect(formatSecretLastUsed("2026-11-24T12:00:00.000Z")).toContain("Last used");
  });
});
