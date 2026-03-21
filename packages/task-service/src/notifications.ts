import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getSqlite } from "@orc/db/client";

const logger = createLogger("task-service:notify");

export async function notifyReview(taskId: string, title: string): Promise<void> {
  logger.info(`Review notification: task ${taskId} "${title}" ready for review`);

  try {
    const config = loadConfig();

    if (config.gateway.telegram.enabled && config.gateway.telegram.default_chat_id) {
      const chatId = config.gateway.telegram.default_chat_id;
      const message = `📋 Task ready for review:\n*${title}*\nID: \`${taskId}\`\n\nApprove: set status to "done"\nReject: set status to "changes_requested" with comment`;
      const msgId = ulid();
      const sqlite = getSqlite();

      sqlite
        .query(
          `INSERT INTO bridge_messages (id, chat_id, direction, role, text, created_at)
           SELECT ?, bc.id, 'out', 'system', ?, unixepoch()
           FROM bridge_chats bc WHERE bc.platform = 'telegram' AND bc.chat_id = ? LIMIT 1`,
        )
        .run(msgId, message, chatId);
      logger.info(`Review notification queued for Telegram chat ${chatId}`);
    }
  } catch (err) {
    logger.warn(`Failed to send review notification: ${String(err)}`);
  }
}
