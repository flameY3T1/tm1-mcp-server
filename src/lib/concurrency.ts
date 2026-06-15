/**
 * Map over `items` running at most `limit` async calls in flight at once.
 *
 * Semantics mirror `Promise.allSettled` — the returned array is index-aligned
 * with `items`, never rejects, and preserves per-item fulfilled/rejected status.
 * The bound matters when fanning out one request per cube/process against TM1:
 * an unbounded `Promise.allSettled` over a large model can flood the server's
 * worker pool, whereas this keeps pressure constant.
 */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
