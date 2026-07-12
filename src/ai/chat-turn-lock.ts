const locks = new Map<string, Promise<unknown>>();

/** Serialize the complete provider-neutral turn transaction for one scoped
 * Rune conversation. Different products/transports/users remain concurrent. */
export async function withChatTurnLock<T>(key: string, turn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(turn);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}
