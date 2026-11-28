/**
 * The simulated clock: simulated time runs SPEED times faster than the wall
 * clock, from the moment the clock is created.
 *
 * Two kinds of time, never mixed:
 *
 * - WALL time is what the virtual phone stamps on everything it sends
 *   (`occurred_at`, `recorded_at`, `position_recorded_at`,
 *   X-Client-Sent-At): the server compares them with its own clock — the
 *   2-minute geofence window, late proofs, the 16-hour left-open rule, the
 *   5-minute "clock ahead" ping filter — so they must be real instants.
 * - SIM time is the day being simulated: how far the truck drove, how long
 *   the driver stood at the door. `sleepSim` waits it out in wall time
 *   divided by the speed.
 */
interface SimClockOptions {
  speed: number;

  /** The wall clock; Date.now by default (tests pass their own). */
  now?: () => number;

  /** Waits wall milliseconds; setTimeout by default (tests pass their own). */
  sleep?: (wallMs: number) => Promise<void>;
}

const realSleep = (wallMs: number) =>
  new Promise<void>((done) => setTimeout(done, wallMs));

class SimClock {
  readonly speed: number;

  /** Wall instant the simulation started at; also the sim clock's origin. */
  readonly startedAt: number;

  private readonly now: () => number;
  private readonly sleeper: (wallMs: number) => Promise<void>;

  constructor(options: SimClockOptions) {
    if (!Number.isFinite(options.speed) || options.speed <= 0) {
      throw new Error(`SIM_SPEED inválido: ${options.speed}`);
    }

    this.speed = options.speed;
    this.now = options.now ?? Date.now;
    this.sleeper = options.sleep ?? realSleep;
    this.startedAt = this.now();
  }

  wallNow(): number {
    return this.now();
  }

  wallIso(): string {
    return new Date(this.wallNow()).toISOString();
  }

  /** Simulated milliseconds since the start. */
  elapsedSimMs(): number {
    return (this.now() - this.startedAt) * this.speed;
  }

  /** The simulated instant (origin: the wall start). */
  simNow(): number {
    return this.startedAt + this.elapsedSimMs();
  }

  simIso(): string {
    return new Date(this.simNow()).toISOString();
  }

  toWallMs(simMs: number): number {
    return simMs / this.speed;
  }

  toSimMs(wallMs: number): number {
    return wallMs * this.speed;
  }

  /** Waits `simMs` of simulated time. */
  async sleepSim(simMs: number): Promise<void> {
    if (!(simMs > 0)) return;

    await this.sleeper(this.toWallMs(simMs));
  }
}

export { SimClock };
export type { SimClockOptions };
