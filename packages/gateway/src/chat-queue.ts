/**
 * Runs each chat's work in arrival order without making the caller wait for it.
 * Chats run independently; a failed item is reported and the chat's queue continues.
 */
export function createChatQueue(onError: (err: unknown, chatId: string) => void) {
  const tails = new Map<string, Promise<void>>();
  return (chatId: string, work: () => Promise<void>): Promise<void> => {
    const tail = (tails.get(chatId) ?? Promise.resolve())
      .then(work)
      .catch((err) => onError(err, chatId));
    tails.set(chatId, tail);
    void tail.then(() => {
      if (tails.get(chatId) === tail) tails.delete(chatId);
    });
    return tail;
  };
}
