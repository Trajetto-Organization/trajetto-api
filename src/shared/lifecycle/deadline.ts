/**
 * Whether `work` settles within `ms`: true as soon as it resolves or
 * rejects, false once the time is up. Never rejects, and leaves no timer
 * behind either way. A deadline that is not a finite number waits for the
 * work, however long it takes.
 *
 * For the steps of the graceful shutdown that wait on something outside the
 * process — a client still sending its request, the database, Redis. Each
 * gets the share of the stop grace the plan gives it (shutdown-plan.ts), and
 * past it the caller gives up its own way, instead of the watchdog's exit(1)
 * coming before the steps still to run.
 */
function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  const settled = work.then(
    () => true,
    () => true,
  );

  if (!Number.isFinite(ms)) return settled;

  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    settled,
    new Promise<boolean>((resolve) => {
      // Node turns a delay above 2^31 − 1 ms into 1 ms.
      timer = setTimeout(
        () => resolve(false),
        Math.min(Math.max(0, ms), 2_147_483_647),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export { settlesWithin };
