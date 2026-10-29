/**
 * `Promise.all` over thunks, with at most `limit` of them running at once.
 *
 * For a handful of independent reads in one request: in sequence they cost
 * the sum of their round trips; all at once they take as many connections
 * of the replica's pool (10, shared with every other request and the
 * workers) as there are reads. A small limit keeps most of the gain and
 * leaves the pool to everyone else. Results come back in the tasks' order;
 * the first failure rejects, like `Promise.all`, and the tasks not started
 * yet are not started.
 */
async function boundedAll<T extends readonly (() => Promise<unknown>)[]>(
  limit: number,
  tasks: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results: unknown[] = new Array(tasks.length);
  let next = 0;
  let failed = false;

  async function lane(): Promise<void> {
    while (!failed && next < tasks.length) {
      const index = next;
      next += 1;

      try {
        results[index] = await tasks[index]();
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, lane),
  );

  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

export { boundedAll };
