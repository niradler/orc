import { describe, expect, test } from "bun:test";
import {
  COMMAND_ARGUMENT_MANUAL,
  commandArgumentFromPicker,
  commandArgumentPickerValue,
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

describe("command argument saved-secret picker", () => {
  test("maps a project reference to itself and anything else to manual entry", () => {
    expect(commandArgumentPickerValue("project/deploy-token")).toBe("project/deploy-token");
    expect(commandArgumentPickerValue("")).toBe(COMMAND_ARGUMENT_MANUAL);
    expect(commandArgumentPickerValue("typed-secret")).toBe(COMMAND_ARGUMENT_MANUAL);
    expect(commandArgumentPickerValue("project/")).toBe(COMMAND_ARGUMENT_MANUAL);
    expect(commandArgumentPickerValue("project/has space")).toBe(COMMAND_ARGUMENT_MANUAL);
  });

  test("manual selection clears the value while a reference selection keeps it", () => {
    expect(commandArgumentFromPicker(COMMAND_ARGUMENT_MANUAL)).toBe("");
    expect(commandArgumentFromPicker("project/deploy-token")).toBe("project/deploy-token");
  });

  test("round-trips between typed and saved modes without losing the reference", () => {
    const reference = "project/openai-key";
    expect(commandArgumentFromPicker(commandArgumentPickerValue(reference))).toBe(reference);
    expect(commandArgumentFromPicker(commandArgumentPickerValue("literal"))).toBe("");
  });
});
