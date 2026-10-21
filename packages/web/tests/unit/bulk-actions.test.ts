import { expect, test } from "bun:test";
import { applyBulkAction } from "../../src/lib/bulk-actions";

test("should retain individual failures for retry while applying other selected records once", async () => {
  const applied: string[] = [];
  const result = await applyBulkAction(["first", "denied", "last", "first"], async (id) => {
    if (id === "denied") throw new Error("Not allowed");
    applied.push(id);
  });
  expect(applied).toEqual(["first", "last"]);
  expect(result).toEqual({
    succeeded: ["first", "last"],
    failed: [{ id: "denied", error: "Not allowed" }],
  });
  expect(
    await applyBulkAction([], async () => {
      throw new Error("Must not run");
    }),
  ).toEqual({ succeeded: [], failed: [] });
});
