export {
  getGatewayManager,
  getGatewayStatus,
  notifyTaskReview,
  sendGatewayMessage,
  startGateway,
  stopGateway,
} from "./manager.js";
export { resolveChatKey } from "./store.js";
export type { TelegramRecipient, TelegramSendResult, TelegramStatus } from "./telegram-outbound.js";
export { sendTelegramToNir, telegramStatus } from "./telegram-outbound.js";
export type {
  Button,
  DirectCommandResult,
  GatewayAdapter,
  IncomingMessage,
  SendOpts,
} from "./types.js";
