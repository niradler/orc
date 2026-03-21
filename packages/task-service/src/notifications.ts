import { createLogger } from "@orc/core/logger";

const logger = createLogger("task-service:notify");

export async function notifyReview(taskId: string, title: string): Promise<void> {
  logger.info(`Review notification: task ${taskId} "${title}" ready for review`);
}
