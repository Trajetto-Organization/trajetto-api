/**
 * The replica's sockets closed in slices over the shutdown's drain, not all
 * at once at its end (plano-escala U-01, F2.19).
 *
 * The engine used to be closed in one go when the drain ended
 * (`closeRealtimeConnections`): every phone and every tab on the replica got
 * "transport close" in the same millisecond and reconnected together, so a
 * deploy of a replica holding 1,000 sockets sent 1,000 handshakes — three
 * Postgres round trips each — to the replicas left over in the same second.
 * Now 1/N of the sockets go each second, N being the drain's seconds (12
 * with the 40 s grace), each with `socket.conn.close()`, which the clients
 * read as a dropped transport and answer by reconnecting. The task left the
 * Swarm's virtual address before the SIGTERM, so the reconnection goes to
 * another replica.
 *
 * The slice is recomputed at every tick from the sockets still here, so the
 * ones that leave on their own or arrive late do not skew it, and the last
 * tick takes whatever is left. What arrives after the last tick is closed by
 * `closeRealtimeConnections` with the engine, as before.
 */

/** One slice a second: the unit the plan is written in. */
const GRADUAL_CLOSE_TICK_MS = 1_000;

/** How many of `remaining` the tick closes, with `ticksLeft` to go. */
function sliceSize(remaining: number, ticksLeft: number): number {
  if (remaining <= 0) return 0;
  if (ticksLeft <= 1) return remaining;

  return Math.ceil(remaining / ticksLeft);
}

/** Ticks over a window: one per second, at least one. */
function ticksIn(windowMs: number, tickMs = GRADUAL_CLOSE_TICK_MS): number {
  return Math.max(1, Math.floor(windowMs / tickMs));
}

interface GradualCloseOptions<T> {
  /** The sockets still open, read at each tick. */
  sockets: () => T[];

  close: (socket: T) => void;

  /** The drain: the slices end within it. */
  windowMs: number;

  tickMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Starts closing at once (the first slice goes now) and returns the stop.
 * Never throws: a socket whose close fails is left to the engine's close.
 */
function startGradualClose<T>(options: GradualCloseOptions<T>): () => void {
  const tickMs = options.tickMs ?? GRADUAL_CLOSE_TICK_MS;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => setTimeout(run, ms) as NodeJS.Timeout);
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));

  let ticksLeft = ticksIn(options.windowMs, tickMs);
  let timer: unknown = null;
  let stopped = false;

  const tick = () => {
    timer = null;

    if (stopped) return;

    const open = options.sockets();

    for (const socket of open.slice(0, sliceSize(open.length, ticksLeft))) {
      try {
        options.close(socket);
      } catch {
        // The engine's close at the end of the drain gets it.
      }
    }

    ticksLeft -= 1;

    if (ticksLeft > 0) {
      const next = setTimer(tick, tickMs);

      // Never the reason a process stays alive.
      (next as { unref?: () => void }).unref?.();
      timer = next;
    }
  };

  tick();

  return () => {
    stopped = true;

    if (timer !== null) clearTimer(timer);
    timer = null;
  };
}

export { GRADUAL_CLOSE_TICK_MS, sliceSize, startGradualClose, ticksIn };
export type { GradualCloseOptions };
