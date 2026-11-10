import { expect, test } from "bun:test";
import {
  describeError,
  errorDisplayText,
  isStaleBuildError,
  reloadForStaleBuild,
} from "../../src/lib/app-errors";

function memoryStorage(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

test("should recognize a chunk that a new deployment replaced in every browser wording", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: https://orc.example/assets/Terminals-abc.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/Terminals-abc.css",
  ]) {
    expect(isStaleBuildError(new Error(message))).toBe(true);
  }
});

test("should leave real application errors for the error panel", () => {
  expect(isStaleBuildError(new Error("Cannot read properties of undefined"))).toBe(false);
  expect(isStaleBuildError("TypeError: x is not a function")).toBe(false);
  expect(isStaleBuildError(undefined)).toBe(false);
});

test("should reload once for a replaced chunk and stop a reload loop", () => {
  const storage = memoryStorage();
  let reloads = 0;
  const reload = () => {
    reloads += 1;
  };

  expect(reloadForStaleBuild({ storage, reload, now: 1_000_000 })).toBe(true);
  expect(reloadForStaleBuild({ storage, reload, now: 1_000_001 })).toBe(false);
  expect(reloads).toBe(1);

  // The guard expires, so a later deployment in the same tab can recover again.
  expect(reloadForStaleBuild({ storage, reload, now: 1_000_000 + 15_000 })).toBe(true);
  expect(reloads).toBe(2);
});

test("should show the error panel instead of looping when the guard cannot be stored", () => {
  let reloads = 0;
  const storage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  expect(
    reloadForStaleBuild({
      storage,
      reload: () => {
        reloads += 1;
      },
    }),
  ).toBe(false);
  expect(reloads).toBe(0);
});

test("should not reload unguarded when session storage is unavailable", () => {
  // Browsers that block cookies throw on the sessionStorage getter, and a reload
  // every attempt would loop the tab forever.
  let reloads = 0;
  expect(
    reloadForStaleBuild({
      storage: null,
      reload: () => {
        reloads += 1;
      },
    }),
  ).toBe(false);
  expect(reloads).toBe(0);
});

test("should describe the original error so the report keeps its name, message and stack", () => {
  const error = new TypeError("boom");
  const details = describeError(error);
  expect(details.name).toBe("TypeError");
  expect(details.message).toBe("boom");
  expect(details.stack).toContain("boom");
  expect(describeError("plain")).toEqual({ name: "Error", message: "plain", stack: null });
  expect(describeError({ code: 500 }).message).toBe('{"code":500}');
});

test("should not print the message twice when the stack already starts with it", () => {
  const error = new TypeError("Failed to fetch dynamically imported module: /assets/x.js");
  expect(errorDisplayText(error)).toBe(error.stack);
  const withoutStack = new Error("no stack here");
  withoutStack.stack = undefined;
  expect(errorDisplayText(withoutStack)).toBe("Error: no stack here");
  const custom = new Error("boom");
  custom.stack = "at somewhere";
  expect(errorDisplayText(custom)).toBe("Error: boom\n\nat somewhere");
});
