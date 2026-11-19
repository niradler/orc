import type {
  ChannelConnection,
  ChannelInbound,
  ChannelMessage,
  ChannelProviderInfo,
} from "@orc/core/channels";
import { OrcError, ValidationError } from "@orc/core/errors";
import { UPLOAD_MAX_BYTES, type UploadFile } from "@orc/core/session-file-types";

export type NativePayload = Record<string, unknown>;
export type ProviderIdentity = { id: string; name: string };
export type ChannelAttachment = NonNullable<ChannelInbound["attachments"]>[number];
export type ChannelButton = { label: string; value: string };
export type RenderedMessage = { payloads: NativePayload[]; warnings: string[] };
export type ChannelTransport = {
  downloadFile?(file: ChannelAttachment): Promise<UploadFile>;
  identity(): Promise<ProviderIdentity>;
  send(payload: NativePayload): Promise<string>;
  edit(id: string, payload: NativePayload): Promise<void>;
  start(receive: (message: ChannelInbound) => void, failed: (code: string) => void): Promise<void>;
  stop(): Promise<void>;
};
export type TransportState = { loadCursor(): string | undefined; saveCursor(cursor: string): void };
export type TransportFactory = (
  connection: ChannelConnection,
  credentials: Record<string, string>,
  state?: TransportState,
) => ChannelTransport;

export type ChannelProvider = {
  info: ChannelProviderInfo;
  accountKey: string;
  replyControls: boolean;
  manifest?: Record<string, unknown>;
  transport: TransportFactory;
  render(message: ChannelMessage): RenderedMessage;
  destination(chat: string, thread?: string): NativePayload;
  controls(text: string, format: ChannelMessage["format"], rows: ChannelButton[][]): NativePayload;
  pairing(identity: ProviderIdentity, token: string): { url: string; message: string };
};

export class ProviderFailure extends OrcError {
  constructor(
    code: string,
    readonly ambiguous = false,
  ) {
    super(`Channel provider: ${code}`, "CHANNEL_PROVIDER_ERROR", 502);
  }
}

const knownCodes = new Set([
  "rate_limited",
  "invalid_response",
  "network_or_timeout",
  "webhook_already_owned",
  "invalid_socket_url",
  "socket_connect_timeout",
  "socket_connect_failed",
  "socket_disconnected",
  "polling_failed",
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "account_inactive",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "restricted_action",
]);
export function safeProviderCode(value: string): string {
  const code = value.replace(/^Channel provider: /, "");
  if (/^http_[1-5][0-9]{2}_code_[0-9]{1,3}$/.test(code)) return code;
  return knownCodes.has(code) ? code : "provider_failure";
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: NativePayload,
  signal?: AbortSignal,
  retry = 0,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(15000),
      redirect: "error",
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 429 || Number(body.error_code) === 429) {
      const parameters = body.parameters as { retry_after?: number } | undefined;
      const seconds = Number(response.headers.get("retry-after") ?? parameters?.retry_after ?? 1);
      if (retry < 2 && Number.isFinite(seconds) && seconds >= 0 && seconds <= 30) {
        await Bun.sleep(Math.max(250, seconds * 1000));
        return postJson(url, headers, payload, signal, retry + 1);
      }
      throw new ProviderFailure("rate_limited");
    }
    if (response.ok && !Object.hasOwn(body, "ok"))
      throw new ProviderFailure("invalid_response", true);
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure("network_or_timeout", true);
  }
}

export async function downloadBounded(
  url: string,
  headers: Record<string, string>,
  file: ChannelAttachment,
  label: string,
): Promise<UploadFile> {
  const tooLarge = () => new ValidationError(`${label} files must be at most 20 MB`);
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (!response.ok || !response.body) throw new ProviderFailure("file_download_failed");
    if (Number(response.headers.get("content-length")) > UPLOAD_MAX_BYTES) throw tooLarge();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > UPLOAD_MAX_BYTES) throw tooLarge();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      name: file.name,
      mimeType: file.mimeType,
      data,
      ...(file.description ? { description: file.description } : {}),
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof ProviderFailure) throw error;
    throw new ProviderFailure("file_download_failed");
  }
}
