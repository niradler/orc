import { expect, test } from "bun:test";
import { previewObservation } from "./preview-observation.js";

test("should recover a disposed navigation frame, preserving permission checks and unrelated errors", async () => {
  let reads = 0;
  expect(
    await previewObservation(
      async () => {
        if (++reads === 1)
          throw new Error("Render frame was disposed before WebFrameMain could be accessed");
        return "new document";
      },
      () => {},
    ),
  ).toBe("new document");
  expect(reads).toBe(2);
  let allowed = true;
  reads = 0;
  await expect(
    previewObservation(
      async () => {
        reads++;
        allowed = false;
        throw new Error("Render frame was disposed");
      },
      () => {
        if (!allowed) throw new Error("Revoked");
      },
    ),
  ).rejects.toThrow("Revoked");
  expect(reads).toBe(1);
  reads = 0;
  await expect(
    previewObservation(
      async () => {
        reads++;
        throw new Error("Stale browser ref");
      },
      () => {},
    ),
  ).rejects.toThrow("Stale browser ref");
  expect(reads).toBe(1);
});
