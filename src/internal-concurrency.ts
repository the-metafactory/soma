/**
 * Internal concurrency helper used by importers and migrators.
 *
 * Not exported from `src/index.ts` — this is plumbing for the
 * pai-pack-importer, pai-memory-migrator, pai-migration modules.
 * Sage r2 #95 Maintainability nit (avoid two copies of the same
 * worker-loop generic that could drift in limit / error-ordering
 * semantics).
 */

/**
 * Run async per-item work with a bounded concurrency window. Results
 * are returned in input order regardless of when individual workers
 * resolve, which keeps downstream code (manifests, audits) stable
 * across runs.
 *
 * Behavior:
 *   - Empty input → empty output, no workers started.
 *   - `limit` is capped at `items.length` so we never spawn more
 *     workers than work.
 *   - Errors propagate to the first awaiter; remaining in-flight
 *     work continues to settle before `Promise.all` rejects, so
 *     no orphan FDs from already-started reads.
 */
export async function runBoundedConcurrent<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
