import { expect, test } from "bun:test";
import { draftCheckoutId, parseDraftCheckoutId } from "../chat";

test("draft checkout id round-trips host and cwd, including unicode and colons", () => {
  const cases = [
    { host: null, cwd: "/Users/nir/projects/orc" },
    { host: "homelab", cwd: "/home/nir/work" },
    { host: null, cwd: "C:\\Users\\nir\\proj" },
    { host: null, cwd: "/tmp/πроект" },
  ];
  for (const workspace of cases) {
    const id = draftCheckoutId(workspace);
    expect(id).not.toBeNull();
    expect(parseDraftCheckoutId(id as string)).toEqual(workspace);
  }
});

test("draft checkout id is absent without a folder and rejects foreign ids", () => {
  expect(draftCheckoutId({ cwd: "   " })).toBeNull();
  expect(draftCheckoutId({ cwd: undefined })).toBeNull();
  expect(parseDraftCheckoutId("term_01HT")).toBeNull();
  expect(parseDraftCheckoutId("draft:not-base64!!")).toBeNull();
});
