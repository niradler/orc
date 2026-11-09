import { expect, test } from "bun:test";
import { PreviewExecutionLedger } from "../../src/lib/preview-delivery";

test("should retain completed and failed actions when acknowledgement is retried", async () => {
  const ledger = new PreviewExecutionLedger();
  let clicks = 0;
  const execute = async () => {
    clicks++;
    return { status: "completed" as const, error: null, result: { ok: true } };
  };
  const [first, retry] = await Promise.all([
    ledger.run("click", execute),
    ledger.run("click", execute),
  ]);
  expect(first).toEqual(retry);
  expect(clicks).toBe(1);
  expect(await ledger.run("click", execute)).toEqual(first);
  expect(clicks).toBe(1);
  let failures = 0;
  const fail = async () => {
    failures++;
    throw new Error("Page changed");
  };
  expect(await ledger.run("failed", fail)).toEqual({ status: "failed", error: "Page changed" });
  await ledger.run("failed", fail);
  expect(failures).toBe(1);
});
