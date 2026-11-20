/**
 * Wraps an async `load` so that its result is reused for `ttlMs` after it resolves, and callers that arrive while a load
 * is running share that load instead of starting their own. A failed load is not cached: the next call tries again.
 * With `ttlMs` <= 0 nothing is reused once a load has finished, but concurrent callers still share it.
 */
export function cachedLoader<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let cached: { value: T; expiresAt: number } | undefined;
  let pending: Promise<T> | undefined;

  return () => {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
    if (!pending) {
      pending = load()
        .then((value) => {
          cached = { value, expiresAt: now() + ttlMs };
          return value;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    return pending;
  };
}
