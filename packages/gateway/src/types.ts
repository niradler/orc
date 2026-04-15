import type { GatewayMode, GatewayPlatform } from "@orc/core/types";

export type SupportedGatewayPlatform = "telegram" | "slack";

export type Attachment =
  | {
      kind: "audio";
      data: Uint8Array;
      mimeType: string;
      format: string;
      duration?: number | undefined;
    }
  | { kind: "image"; data: Uint8Array; mimeType: string; fileName?: string | undefined };

export type IncomingMessage = {
  platform: GatewayPlatform;
  chatId: string;
  userId: string;
  username?: string | undefined;
  displayName?: string | undefined;
  text: string;
  threadId?: string | undefined;
  platformMessageId?: string | undefined;
  attachments?: Attachment[] | undefined;
  fromVoice?: boolean | undefined;
};

export type Button = { label: string; value: string };

export type SendOpts = {
  threadId?: string | undefined;
  buttons?: Button[][] | undefined;
  parseMode?: "html" | "markdown" | undefined;
};

export type GatewayAdapter = {
  readonly platform: SupportedGatewayPlatform;
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string, opts?: SendOpts): Promise<string | undefined>;
};

export interface SupportsMessageUpdate {
  updateMessage(chatId: string, msgId: string, text: string, opts?: SendOpts): Promise<void>;
}

export interface SupportsInlineButtons {
  sendWithButtons(
    chatId: string,
    text: string,
    buttons: Button[][],
    opts?: Omit<SendOpts, "buttons">,
  ): Promise<string | undefined>;
}

export interface SupportsVoice {
  downloadAudio(fileRef: string): Promise<Uint8Array>;
  sendAudio(chatId: string, audio: Uint8Array, format: string, caption?: string): Promise<void>;
}

export interface SupportsTyping {
  showTyping(chatId: string): Promise<void>;
}

export interface SupportsCommandRegistration {
  registerCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
}

export type GatewaySessionRuntime = {
  backend: string;
  run(input: {
    cwd: string;
    prompt: string;
    sessionId: string;
    model?: string | undefined;
  }): Promise<{ output: string; runtimeSessionId?: string | undefined }>;
};

export type SessionSummary = {
  id: string;
  backend: string;
  title: string | null;
  cwd: string | null;
  status: string;
  taskId: string | null;
  updatedAt: Date;
};

export type DirectCommandResult = {
  text?: string | undefined;
  html?: string | undefined;
  mode?: GatewayMode | undefined;
  buttons?: Button[][] | undefined;
  projectId?: string | null | undefined;
};
