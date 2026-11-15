import { performance } from "node:perf_hooks";

/**
 * How pressed this replica is, for the hints it hands its clients
 * (plano-escala F2-26).
 *
 * The driver's app flushes its positions every 60 s whatever the server is
 * going through: at 20k drivers that is ~333 POST/s, and a replica with its
 * event loop saturated got the same stream as an idle one, every late answer
 * pulling the next retry closer. Each answer of POST /route/positions now
 * says how long to wait before the next flush (`nextFlushAfterMs`), from the
 * replica's own event-loop utilisation (ELU): the app waits the longer of it
 * and its own interval, with a 5-minute ceiling (F2-27), and keeps the
 * points on the phone meanwhile — the map lags, nothing is lost.
 *
 * Per replica, on purpose: the replica that answers is the one that is
 * pressed, and its ELU is a counter read in memory — no query, no Redis, no
 * timer — so the hottest route in the product pays nothing for the hint.
 */
type PressureLevel = "normal" | "elevated" | "critical";

/** At or above this ELU the replica is pressed: the flush is spaced out. */
const ELEVATED_ELU = 0.7;

/** At or above this ELU (or while shedding) the flush waits the most. */
const CRITICAL_ELU = 0.9;

/** The app's ceiling for any wait between flushes (F2-27). */
const POSITIONS_FLUSH_AFTER_MAX_MS = 300_000;

/** The flush interval the app has today, and the hint without pressure. */
const POSITIONS_FLUSH_AFTER_DEFAULT_MS = 60_000;

/** One point is taken every 15 s: a shorter hint would be a flush of nothing. */
const POSITIONS_FLUSH_AFTER_MIN_MS = 15_000;

function pressureLevelFor({
  elu,
  shedding,
}: {
  elu: number;
  shedding: boolean;
}): PressureLevel {
  if (shedding) return "critical";

  // A reading that makes no sense says nothing about pressure; slowing the
  // whole fleet down on it would be the worse mistake.
  if (!Number.isFinite(elu) || elu < 0) return "normal";

  if (elu >= CRITICAL_ELU) return "critical";
  if (elu >= ELEVATED_ELU) return "elevated";

  return "normal";
}

/**
 * The positions hint for a level: the base (POSITIONS_FLUSH_AFTER_MS,
 * 60 s), twice it when pressed, the app's 5-minute ceiling when critical.
 * Never below the base nor above the ceiling.
 */
function positionsFlushAfterMs(level: PressureLevel, baseMs: number): number {
  const base = Math.min(baseMs, POSITIONS_FLUSH_AFTER_MAX_MS);

  if (level === "critical") return POSITIONS_FLUSH_AFTER_MAX_MS;
  if (level === "elevated")
    return Math.min(base * 2, POSITIONS_FLUSH_AFTER_MAX_MS);

  return base;
}

interface LoopTimes {
  idle: number;
  active: number;
}

/**
 * The ELU over the last full window, kept by the reads themselves: when a
 * read finds the window over, it closes it and starts the next. No timer
 * runs for it. Before the first window closes, the time so far answers. A
 * replica that nobody asks for a while reads the long quiet window as low,
 * which is what it was.
 */
function createEluWindow({
  windowMs = 5_000,
  read = () => performance.eventLoopUtilization() as LoopTimes,
  now = () => performance.now(),
}: {
  windowMs?: number;
  read?: () => LoopTimes;
  now?: () => number;
} = {}): { current: () => number } {
  let mark = read();
  let markedAt = now();
  let last: number | null = null;

  const utilization = (from: LoopTimes, to: LoopTimes): number => {
    const active = to.active - from.active;
    const total = active + (to.idle - from.idle);

    return total > 0 ? active / total : 0;
  };

  return {
    current() {
      const reading = read();

      if (now() - markedAt >= windowMs) {
        last = utilization(mark, reading);
        mark = reading;
        markedAt = now();
      }

      return last ?? utilization(mark, reading);
    },
  };
}

/** This process's window, shared by every read. */
const processElu = createEluWindow();

/**
 * Whether the replica is shedding load right now. Nothing sheds yet: the
 * load-shedding item (wave 9) registers its probe here, and while it does,
 * the hint is the longest one.
 */
let sheddingProbe: () => boolean = () => false;

function registerSheddingProbe(probe: () => boolean): void {
  sheddingProbe = probe;
}

/** The replica's level now: its ELU and whether it is shedding. */
function currentPressureLevel(): PressureLevel {
  let shedding = false;

  try {
    shedding = sheddingProbe();
  } catch {
    // A probe that throws says nothing; the hint must never fail a flush.
    shedding = false;
  }

  return pressureLevelFor({ elu: processElu.current(), shedding });
}

export {
  CRITICAL_ELU,
  ELEVATED_ELU,
  POSITIONS_FLUSH_AFTER_DEFAULT_MS,
  POSITIONS_FLUSH_AFTER_MAX_MS,
  POSITIONS_FLUSH_AFTER_MIN_MS,
  createEluWindow,
  currentPressureLevel,
  positionsFlushAfterMs,
  pressureLevelFor,
  registerSheddingProbe,
  type PressureLevel,
};
