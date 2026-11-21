import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { mockChatThread, NOTIFY_CHAT_THREAD } from "./_agent-notifications";
import { gotoView } from "./_helpers";

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone"],
});

function toneWav(seconds: number) {
  const rate = 16_000;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "latin1");
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8, "latin1");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "latin1");
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
  return wav;
}

async function openVoiceChat(page: Page) {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const w = window as unknown as { streams: MediaStream[] };
    w.streams = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      w.streams.push(stream);
      return stream;
    };
  });
  await mockChatThread(page);
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({ json: { available: true, max_bytes: 26_214_400, voice_mode: true } }),
  );
  await page.route(`**/api/chat/threads/${NOTIFY_CHAT_THREAD}/voice/ticket`, (route) =>
    route.fulfill({ json: { ticket: "test-ticket", expires_in: 30 } }),
  );
  const voice: { socket?: WebSocketRoute; frames: number; closed: boolean; url: string } = {
    frames: 0,
    closed: false,
    url: "",
  };
  await page.routeWebSocket(`**/chat/threads/${NOTIFY_CHAT_THREAD}/voice**`, (ws) => {
    voice.socket = ws;
    voice.url = ws.url();
    ws.onMessage((message) => {
      if (typeof message !== "string" && message.length % 2 === 0) voice.frames++;
    });
    ws.onClose(() => {
      voice.closed = true;
    });
    ws.send(JSON.stringify({ type: "ready" }));
  });
  await gotoView(page, "tasks");
  await page.goto(`/chat?project=all&chatThread=${NOTIFY_CHAT_THREAD}`);
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  return voice;
}

const liveTracks = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { streams: MediaStream[] }).streams.some((stream) =>
      stream.getTracks().some((track) => track.readyState === "live"),
    ),
  );

for (const [label, size] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(`voice mode at ${size.width}px`, () => {
    test.use({ viewport: size, hasTouch: label === "phone" });

    test("streams mic audio, plays speech, barges in and releases on stop", async ({ page }) => {
      const voice = await openVoiceChat(page);
      const button = page.getByTestId("chat-voice-button");
      if (label === "phone")
        expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await button.click();

      const overlay = page.getByTestId("chat-voice-overlay");
      await expect(overlay).toHaveAttribute("data-cue", "listening", { timeout: 20_000 });
      await expect(page.getByTestId("chat-composer-tools")).toBeHidden();
      await expect(page.getByTestId("chat-send-button")).toBeHidden();
      expect(voice.url).toContain("ticket=test-ticket");
      await expect.poll(() => voice.frames).toBeGreaterThan(5);
      await expect
        .poll(async () =>
          Number(await page.getByTestId("chat-voice-level").getAttribute("data-level")),
        )
        .toBeGreaterThan(0);
      if (label === "phone")
        for (const id of ["chat-voice-mute", "chat-voice-stop"])
          expect((await page.getByTestId(id).boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);

      voice.socket?.send(JSON.stringify({ type: "speech_start" }));
      await expect(overlay).toHaveAttribute("data-cue", "hearing");
      voice.socket?.send(JSON.stringify({ type: "speech_end" }));
      await expect(overlay).toHaveAttribute("data-cue", "thinking");
      voice.socket?.send(JSON.stringify({ type: "transcript", text: "run the tests" }));
      voice.socket?.send(JSON.stringify({ type: "speak", id: "1", text: "On it.", format: "wav" }));
      voice.socket?.send(toneWav(3));
      await expect(overlay).toHaveAttribute("data-cue", "speaking");

      // A knock ducks the reply and restores it; only a confirmed barge stops it.
      voice.socket?.send(JSON.stringify({ type: "speech_start" }));
      await expect(overlay).toHaveAttribute("data-cue", "hearing");
      voice.socket?.send(JSON.stringify({ type: "speech_cancelled" }));
      await expect(overlay).toHaveAttribute("data-cue", "speaking");

      voice.socket?.send(JSON.stringify({ type: "speech_start" }));
      await expect(overlay).toHaveAttribute("data-cue", "hearing");
      voice.socket?.send(JSON.stringify({ type: "barge" }));
      await expect(overlay).toHaveAttribute("data-cue", "hearing");
      voice.socket?.send(JSON.stringify({ type: "speech_end" }));
      await expect(overlay).toHaveAttribute("data-cue", "thinking");
      voice.socket?.send(JSON.stringify({ type: "ignored" }));
      await expect(overlay).toHaveAttribute("data-cue", "listening");

      await page.getByTestId("chat-voice-mute").click();
      await expect(overlay).toHaveAttribute("data-muted", "true");
      await expect(page.getByTestId("chat-voice-cue")).toHaveText("Muted");
      await page.getByTestId("chat-voice-mute").click();
      await expect(overlay).toHaveAttribute("data-muted", "false");

      await page.getByTestId("chat-voice-stop").click();
      await expect(overlay).toHaveCount(0);
      await expect(page.getByTestId("chat-composer-tools")).toBeVisible();
      await expect.poll(() => voice.closed).toBe(true);
      await expect.poll(() => liveTracks(page)).toBe(false);
    });

    test("the shortcut opens voice mode and Escape closes it", async ({ page }) => {
      const voice = await openVoiceChat(page);
      await page.getByTestId("chat-input").press("ControlOrMeta+Shift+Space");
      const overlay = page.getByTestId("chat-voice-overlay");
      await expect(overlay).toHaveAttribute("data-cue", "listening", { timeout: 20_000 });
      await page.keyboard.press("Escape");
      await expect(overlay).toHaveCount(0);
      await expect.poll(() => voice.closed).toBe(true);
      await expect.poll(() => liveTracks(page)).toBe(false);
    });
  });
}

test("voice mode stays hidden when the server has no voice provider", async ({ page }) => {
  await mockChatThread(page);
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({ json: { available: true, max_bytes: 26_214_400, voice_mode: false } }),
  );
  await gotoView(page, "tasks");
  await page.goto(`/chat?project=all&chatThread=${NOTIFY_CHAT_THREAD}`);
  await expect(page.getByTestId("chat-dictation-button")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("chat-voice-button")).toHaveCount(0);
});
