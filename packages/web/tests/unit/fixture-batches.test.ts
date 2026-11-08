import { expect, test } from "bun:test";
import { inFixtureBatches } from "../fixtures/batches.js";

test("should bound concurrent fixture requests without omitting any item", async () => {
  let active = 0;
  let peak = 0;
  const seen: number[] = [];
  await inFixtureBatches(
    Array.from({ length: 106 }, (_, index) => index),
    async (index) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(1);
      seen.push(index);
      active--;
    },
  );
  expect(peak).toBe(10);
  expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 106 }, (_, index) => index));
  expect(active).toBe(0);
});

test("should finish all cleanup batches and report every failure", async () => {
  const seen: number[] = [];
  const failures = [new Error("first cleanup failure"), new Error("last cleanup failure")];
  try {
    await inFixtureBatches(
      Array.from({ length: 31 }, (_, index) => index),
      async (index) => {
        seen.push(index);
        if (index === 0) throw failures[0];
        if (index === 30) throw failures[1];
      },
    );
    throw new Error("Expected cleanup failures");
  } catch (error) {
    if (!(error instanceof AggregateError)) throw error;
    expect(error.errors).toEqual(failures);
  }
  expect(seen).toEqual(Array.from({ length: 31 }, (_, index) => index));
});
