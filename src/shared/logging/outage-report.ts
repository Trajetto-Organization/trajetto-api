/**
 * One log line per interval of an outage, however many failures it holds.
 *
 * While Redis or Postgres is away, every publish or every read fails, and a
 * line for each would bury the log right when someone reads it. So failures
 * are counted: the first one after a quiet interval is logged at once, and
 * whatever follows it goes out in one line when the interval ends. That
 * closing line is what keeps an outage's count its own. Counted only on the
 * next failure, what followed the last line of a short outage waited in
 * memory and was added to the first line of the next one, days later.
 */
interface OutageReport<D> {
  /** `count` failures more; `detail` is the latest one, for the line. */
  failed(count: number, detail?: D): void;

  /** Counted and not logged yet. */
  unreported(): number;
}

interface OutageReportOptions<D> {
  intervalMs: number;
  report: (count: number, detail: D | undefined) => void;
}

function createOutageReport<D = undefined>(
  options: OutageReportOptions<D>,
): OutageReport<D> {
  let pending = 0;
  let latest: D | undefined;
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let closing: NodeJS.Timeout | null = null;

  function report(): void {
    if (closing) clearTimeout(closing);
    closing = null;

    if (pending === 0) return;

    const count = pending;
    const detail = latest;

    pending = 0;
    latest = undefined;
    lastReportAt = Date.now();

    options.report(count, detail);
  }

  return {
    failed(count, detail) {
      pending += count;
      latest = detail;

      const wait = lastReportAt + options.intervalMs - Date.now();

      if (wait <= 0) {
        report();
        return;
      }

      if (closing) return;

      closing = setTimeout(report, wait);

      // Never the reason a process stays alive.
      closing.unref();
    },

    unreported: () => pending,
  };
}

export { createOutageReport };
export type { OutageReport, OutageReportOptions };
