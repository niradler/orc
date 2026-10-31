import type { ChannelInbound } from "@orc/core/channels";
import { UPLOAD_MAX_FILES } from "@orc/core/session-file-types";

type TelegramObject = Record<string, unknown>;
function object(value: unknown): TelegramObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as TelegramObject)
    : {};
}
function label(value: unknown, limit = 1000): string | undefined {
  return typeof value === "string" && value ? value.slice(0, limit) : undefined;
}

export function telegramFile(
  kind: string,
  value: unknown,
  messageId: unknown,
): NonNullable<ChannelInbound["attachments"]>[number] | null {
  const file = object(value);
  if (typeof file.file_id !== "string" || !file.file_id || file.file_id.length > 1024) return null;
  const formats: Record<string, [string, string]> = {
    photo: ["jpg", "image/jpeg"],
    voice: ["ogg", "audio/ogg"],
    video: ["mp4", "video/mp4"],
    live_photo: ["mp4", "video/mp4"],
    video_note: ["mp4", "video/mp4"],
    animation: ["mp4", "video/mp4"],
    audio: ["mp3", "audio/mpeg"],
    sticker: file.is_animated
      ? ["tgs", "application/x-tgsticker"]
      : file.is_video
        ? ["webm", "video/webm"]
        : ["webp", "image/webp"],
  };
  const [extension, mimeType] = formats[kind] ?? ["bin", "application/octet-stream"];
  const details = [`Telegram ${kind.replaceAll("_", " ")}`];
  if (kind === "voice") details.push("voice message; audio is attached as a file, not transcribed");
  if (kind === "sticker")
    details.push(
      file.is_animated ? "animated sticker" : file.is_video ? "video sticker" : "static sticker",
    );
  if (typeof file.duration === "number" && Number.isFinite(file.duration))
    details.push(`${file.duration} seconds`);
  for (const field of ["emoji", "title", "performer", "set_name"]) {
    const text = label(file[field], 120);
    if (text) details.push(`${field}: ${text}`);
  }
  return {
    fileId: file.file_id,
    name: label(file.file_name, 255) ?? `${kind}-${String(messageId).slice(0, 100)}.${extension}`,
    mimeType: label(file.mime_type, 255) ?? mimeType,
    description: details.join("; ").slice(0, 1000),
    ...(typeof file.file_size === "number" && Number.isFinite(file.file_size) && file.file_size >= 0
      ? { size: file.file_size }
      : {}),
  };
}

export function telegramFiles(message: TelegramObject): NonNullable<ChannelInbound["attachments"]> {
  const result: NonNullable<ChannelInbound["attachments"]> = [];
  for (const kind of [
    "animation",
    "document",
    "audio",
    "voice",
    "video",
    "video_note",
    "photo",
    "sticker",
    "live_photo",
  ]) {
    const source =
      kind === "photo" && Array.isArray(message.photo) ? message.photo.at(-1) : message[kind];
    const file = telegramFile(kind, source, message.message_id);
    if (file && !result.some((item) => item.fileId === file.fileId)) result.push(file);
  }
  const livePhoto = object(message.live_photo);
  if (Array.isArray(livePhoto.photo)) {
    const photo = telegramFile("photo", livePhoto.photo.at(-1), message.message_id);
    if (photo && !result.some((item) => item.fileId === photo.fileId)) result.push(photo);
  }
  const entities = [
    ...(Array.isArray(message.entities) ? message.entities : []),
    ...(Array.isArray(message.caption_entities) ? message.caption_entities : []),
  ];
  for (const value of entities) {
    if (result.length >= UPLOAD_MAX_FILES) break;
    const entity = object(value);
    if (
      entity.type !== "custom_emoji" ||
      typeof entity.custom_emoji_id !== "string" ||
      !/^\d{1,30}$/.test(entity.custom_emoji_id)
    )
      continue;
    if (result.some((item) => item.customEmojiId === entity.custom_emoji_id)) continue;
    result.push({
      fileId: `custom-emoji:${entity.custom_emoji_id}`,
      customEmojiId: entity.custom_emoji_id,
      name: `custom-emoji-${entity.custom_emoji_id}.webp`,
      mimeType: "image/webp",
      description: "Telegram custom emoji",
    });
  }
  return result;
}

export function telegramContext(message: TelegramObject): string | undefined {
  const context: TelegramObject = message.message_id
    ? { messageId: String(message.message_id) }
    : {};
  const emojiIds = [
    ...(Array.isArray(message.entities) ? message.entities : []),
    ...(Array.isArray(message.caption_entities) ? message.caption_entities : []),
  ].flatMap((value) => {
    const entity = object(value);
    return entity.type === "custom_emoji" &&
      typeof entity.custom_emoji_id === "string" &&
      /^\d{1,30}$/.test(entity.custom_emoji_id)
      ? [entity.custom_emoji_id]
      : [];
  });
  if (emojiIds.length) context.customEmojiIds = [...new Set(emojiIds)].slice(0, 100);
  const entities = [
    ...(Array.isArray(message.entities) ? message.entities : []),
    ...(Array.isArray(message.caption_entities) ? message.caption_entities : []),
  ];
  const links = entities
    .flatMap((value) => {
      const entity = object(value);
      const url = entity.type === "text_link" ? label(entity.url, 4000) : undefined;
      return url ? [url] : [];
    })
    .slice(0, 20);
  if (links.length) context.links = links;
  if (message.edit_date) context.edited = true;
  const forward = object(message.forward_origin);
  if (message.forward_origin)
    context.forwardedFrom = {
      type: label(forward.type, 100),
      name: label(
        forward.sender_user_name ??
          object(forward.sender_user).first_name ??
          object(forward.chat).title,
      ),
      username: label(object(forward.sender_user).username ?? object(forward.chat).username),
    };
  if (message.media_group_id) context.mediaGroupId = label(message.media_group_id);
  const reply = object(message.reply_to_message);
  if (reply.message_id)
    context.replyTo = {
      messageId: String(reply.message_id),
      ...(label(reply.text ?? reply.caption, 4000)
        ? { text: label(reply.text ?? reply.caption, 4000) }
        : {}),
      ...(object(reply.sticker).emoji ? { stickerEmoji: label(object(reply.sticker).emoji) } : {}),
    };
  if (message.quote) context.quote = label(object(message.quote).text, 4000);
  const contact = object(message.contact);
  if (message.contact)
    context.contact = {
      name: [label(contact.first_name), label(contact.last_name)].filter(Boolean).join(" "),
      phone: label(contact.phone_number),
    };
  const location = object(message.location ?? object(message.venue).location);
  if (typeof location.latitude === "number" && typeof location.longitude === "number")
    context.location = {
      latitude: location.latitude,
      longitude: location.longitude,
      title: label(object(message.venue).title),
      address: label(object(message.venue).address),
    };
  const poll = object(message.poll);
  if (message.poll)
    context.poll = {
      question: label(poll.question),
      options: Array.isArray(poll.options)
        ? poll.options.slice(0, 20).map((item) => label(object(item).text))
        : [],
    };
  const dice = object(message.dice);
  if (message.dice)
    context.dice = {
      emoji: label(dice.emoji),
      value: typeof dice.value === "number" ? dice.value : undefined,
    };
  if (message.game)
    context.game = {
      title: label(object(message.game).title),
      description: label(object(message.game).description),
    };
  if (
    Object.keys(context).length === 1 &&
    context.messageId &&
    !message.text &&
    !message.caption &&
    !telegramFiles(message).length
  )
    return undefined;
  return Object.keys(context).length ? JSON.stringify(context).slice(0, 16000) : undefined;
}

export function telegramReaction(
  update: TelegramObject,
  connection: string,
): ChannelInbound | null {
  const reaction = object(update.message_reaction);
  const user = object(reaction.user);
  const chat = object(reaction.chat);
  if (!reaction.message_id || !user.id || user.is_bot || !chat.id) return null;
  const summarize = (value: unknown) =>
    Array.isArray(value)
      ? value
          .slice(0, 20)
          .map((item) => {
            const entry = object(item);
            if (entry.type === "emoji") return label(entry.emoji, 100);
            if (entry.type === "custom_emoji")
              return `custom emoji ${label(entry.custom_emoji_id, 30) ?? "unknown"}`;
            return label(entry.type, 100);
          })
          .filter(Boolean)
      : [];
  return {
    connection,
    sender: String(user.id),
    chat: String(chat.id),
    message_id: `reaction:${String(update.update_id)}`,
    text: `Telegram reaction changed on message ${String(chat.id)}:${String(reaction.message_id)}: ${JSON.stringify({ previous: summarize(reaction.old_reaction), current: summarize(reaction.new_reaction) })}`,
    kind: "message",
    event: "reaction",
    is_direct: chat.type === "private",
    is_mention: false,
    ...(Array.isArray(reaction.new_reaction)
      ? { attachments: telegramFiles({ entities: reaction.new_reaction }) }
      : {}),
  };
}
