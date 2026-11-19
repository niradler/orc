import type { GatewayMode, GatewayPlatform } from "@orc/core/types";

export type IncomingMessage = {
  connectionId?: string | undefined;
  platform: GatewayPlatform;
  chatId: string;
  userId: string;
  text: string;
  threadId?: string | undefined;
  platformMessageId?: string | undefined;
};

export type Button = { label: string; value: string };

export type SendOpts = {
  projectId?: string | null | undefined;
  threadId?: string | undefined;
  buttons?: Button[][] | undefined;
  parseMode?: "html" | "markdown" | undefined;
};

export type GatewayAdapter = {
  readonly platform: string;
  send(chatId: string, text: string, opts?: SendOpts): Promise<string | undefined>;
};

export interface SupportsInlineButtons {
  sendWithButtons(
    chatId: string,
    text: string,
    buttons: Button[][],
    opts?: Omit<SendOpts, "buttons">,
  ): Promise<string | undefined>;
}

export type DirectCommandResult = {
  text?: string | undefined;
  mode?: GatewayMode | undefined;
  buttons?: Button[][] | undefined;
  projectId?: string | null | undefined;
};
