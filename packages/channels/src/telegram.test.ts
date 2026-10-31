import { expect, test } from "bun:test";
import { telegramContext, telegramFiles, telegramReaction } from "./telegram";

test("should retain every common Telegram media kind with useful file types and descriptions", () => {
  for (const [kind, extension, mime] of [
    ["voice", "ogg", "audio/ogg"],
    ["audio", "mp3", "audio/mpeg"],
    ["video_note", "mp4", "video/mp4"],
    ["video", "mp4", "video/mp4"],
    ["animation", "mp4", "video/mp4"],
    ["document", "bin", "application/octet-stream"],
  ]) {
    const files = telegramFiles({
      message_id: 42,
      [kind as string]: { file_id: kind, duration: 4 },
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      fileId: kind,
      name: `${kind}-42.${extension}`,
      mimeType: mime,
    });
    expect(files[0]?.description).toContain("4 seconds");
  }
  expect(telegramFiles({ message_id: 42, voice: { file_id: "voice" } })[0]?.description).toContain(
    "not transcribed",
  );
  for (const [flags, extension, mime] of [
    [{}, "webp", "image/webp"],
    [{ is_animated: true }, "tgs", "application/x-tgsticker"],
    [{ is_video: true }, "webm", "video/webm"],
  ] as const) {
    const file = telegramFiles({
      message_id: 42,
      sticker: { file_id: "sticker", emoji: "👍", ...flags },
    })[0];
    expect(file?.name).toBe(`sticker-42.${extension}`);
    expect(file?.mimeType).toBe(mime);
    expect(file?.description).toContain("emoji: 👍");
  }
  expect(
    telegramFiles({ message_id: 1, animation: { file_id: "same" }, document: { file_id: "same" } }),
  ).toHaveLength(1);
  expect(
    telegramFiles({
      message_id: 1,
      document: { file_id: "zip", file_name: "project.tar.zst", mime_type: "application/zstd" },
    })[0]?.name,
  ).toBe("project.tar.zst");
});

test("should preserve reply, quote, emoji and structured message context without downloading reply attachments", () => {
  const message = {
    message_id: 42,
    text: "👍 👨‍👩‍👧‍👦",
    media_group_id: "album",
    entities: [
      { type: "custom_emoji", custom_emoji_id: "123" },
      { type: "custom_emoji", custom_emoji_id: "123" },
    ],
    reply_to_message: {
      message_id: 40,
      caption: "Original caption 🙂",
      document: { file_id: "not-current" },
    },
    quote: { text: "quoted text" },
  };
  expect(telegramFiles(message)).toHaveLength(1);
  expect(telegramFiles(message)[0]).toMatchObject({
    customEmojiId: "123",
    description: "Telegram custom emoji",
  });
  expect(JSON.parse(telegramContext(message) ?? "{}")).toEqual({
    messageId: "42",
    customEmojiIds: ["123"],
    mediaGroupId: "album",
    replyTo: { messageId: "40", text: "Original caption 🙂" },
    quote: "quoted text",
  });
  expect(
    telegramFiles({
      entities: Array.from({ length: 100 }, (_, i) => ({
        type: "custom_emoji",
        custom_emoji_id: String(i + 1),
      })),
    }),
  ).toHaveLength(10);
  expect(
    telegramContext({
      contact: { first_name: "Nir", phone_number: "123" },
      location: { latitude: 1, longitude: 2 },
      poll: { question: "Choose", options: [{ text: "Yes" }] },
      dice: { emoji: "🎲", value: 6 },
    }),
  ).toContain("🎲");
});

test("should retain live photo components and hidden link destinations", () => {
  const files = telegramFiles({
    message_id: 4,
    live_photo: { file_id: "motion", duration: 2, photo: [{ file_id: "still" }] },
  });
  expect(files.map((file) => file.mimeType)).toEqual(["video/mp4", "image/jpeg"]);
  const context = telegramContext({
    message_id: 4,
    text: "Click here",
    entities: [{ type: "text_link", url: "https://example.com/path" }],
    edit_date: 123,
    forward_origin: { type: "hidden_user", sender_user_name: "Original sender" },
  });
  expect(JSON.parse(context ?? "{}")).toMatchObject({
    messageId: "4",
    links: ["https://example.com/path"],
    edited: true,
    forwardedFrom: { type: "hidden_user", name: "Original sender" },
  });
});

test("should represent added and removed reactions while refusing anonymous and bot actors", () => {
  const update = {
    update_id: 7,
    message_reaction: {
      message_id: 42,
      user: { id: 12 },
      chat: { id: 20, type: "group" },
      old_reaction: [{ type: "emoji", emoji: "👍" }],
      new_reaction: [{ type: "custom_emoji", custom_emoji_id: "123" }],
    },
  };
  const reaction = telegramReaction(update, "tg");
  expect(reaction).toMatchObject({
    sender: "12",
    chat: "20",
    message_id: "reaction:7",
    kind: "message",
    is_mention: false,
  });
  expect(reaction?.text).toContain('"previous":["👍"]');
  expect(reaction?.text).toContain('"current":["custom emoji 123"]');
  expect(
    telegramReaction(
      {
        ...update,
        message_reaction: { ...update.message_reaction, user: { id: 12, is_bot: true } },
      },
      "tg",
    ),
  ).toBeNull();
  expect(
    telegramReaction(
      {
        ...update,
        message_reaction: { ...update.message_reaction, user: undefined, actor_chat: { id: 20 } },
      },
      "tg",
    ),
  ).toBeNull();
  expect(
    telegramReaction(
      { ...update, message_reaction: { ...update.message_reaction, new_reaction: [] } },
      "tg",
    )?.text,
  ).toContain('"current":[]');
});
