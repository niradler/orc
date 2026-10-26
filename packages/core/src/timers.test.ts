import { describe, expect, test } from "bun:test";
import { setLongTimeout } from "./timers.js";

describe("setLongTimeout", () => {
  test("fires short delays", async () => {
    let fired = false;
    setLongTimeout(() => {
      fired = true;
    }, 1);
    await Bun.sleep(20);
    expect(fired).toBe(true);
  });

  test("waits for delays beyond the 24.8-day timer cap and can be cleared", async () => {
    let fired = false;
    const timer = setLongTimeout(
      () => {
        fired = true;
      },
      30 * 24 * 60 * 60 * 1000,
    );
    await Bun.sleep(20);
    timer.clear();
    expect(fired).toBe(false);
  });

  test("clear cancels a pending short delay", async () => {
    let fired = false;
    setLongTimeout(() => {
      fired = true;
    }, 5).clear();
    await Bun.sleep(20);
    expect(fired).toBe(false);
  });
});
