import { expect, test } from "bun:test";
import { loadConfig, type OrcConfig } from "@orc/core/config";
import { convertAudio } from "../speech/audio.js";
import { speechText } from "../speech.js";

const ffmpeg = Bun.which("ffmpeg");

async function tone(seconds: number): Promise<Uint8Array> {
  const proc = Bun.spawn({
    cmd: [
      ffmpeg ?? "ffmpeg",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${seconds}`,
      "-f",
      "wav",
      "-",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  return new Uint8Array(await new Response(proc.stdout).arrayBuffer());
}

test.skipIf(!ffmpeg)("ffmpeg conversion leaves the event loop free", async () => {
  const wav = await tone(600);
  let ticks = 0;
  let longestGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
    ticks++;
  }, 5);
  const started = performance.now();
  const ogg = await convertAudio(wav, "wav", "ogg");
  const elapsed = performance.now() - started;
  clearInterval(timer);
  expect(new TextDecoder().decode(ogg.slice(0, 4))).toBe("OggS");
  expect(elapsed).toBeGreaterThan(100);
  expect(ticks).toBeGreaterThan(elapsed / 50);
  expect(longestGap).toBeLessThan(100);
});

test.skipIf(!ffmpeg)("a conversion that overruns its timeout is killed", async () => {
  const wav = await tone(600);
  await expect(convertAudio(wav, "wav", "ogg", 20)).rejects.toThrow("timed out after 20ms");
});

test("a reply is shortened for speech without code or markdown", () => {
  const reply = [
    "## Result",
    "",
    "The **tests pass** after the fix in [`retry.ts`](src/retry.ts).",
    "",
    "```ts",
    "export const retries = 3;",
    "```",
    "",
    "- Deploy waits for the health check. Logs are kept for seven days!",
    "- Rollback is manual.",
  ].join("\n");
  expect(speechText(reply)).toBe(
    "Result The tests pass after the fix in retry.ts. Deploy waits for the health check. Logs are kept for seven days! Rollback is manual.",
  );
  expect(speechText(reply, 90)).toBe(
    "Result The tests pass after the fix in retry.ts. Deploy waits for the health check.",
  );
  expect(speechText("one two three four", 9)).toBe("one two");
  expect(speechText("```sh\nbun test\n```")).toBe("");
});

test("an unknown speech provider fails when the config loads", () => {
  expect(() =>
    loadConfig({ speech: { provider: "whisperx" } } as unknown as Partial<OrcConfig>),
  ).toThrow(/Invalid orc config[\s\S]*provider/);
});
