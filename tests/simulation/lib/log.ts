import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

import type { SimClock } from "./clock";

/**
 * The simulation's JSONL log (SIM_LOG): one line per event, in the order
 * they happened. It is the run's evidence, the recorder's milestone feed
 * (trajetto-ui/tests/simulation/record-delivery-day.ts) and the input of a
 * later replay page.
 *
 * Every line carries `wall` (real instant), `sim` (simulated instant),
 * `actor` and `kind`. Kinds:
 *
 * - `http`: every call — method, path (query stripped of tokens), status,
 *   latency, replica, and `unexpected: true` when it was not a planned
 *   answer (a finding);
 * - `event`: a domain event — position flush, route/stop status, proof,
 *   occurrence, authorization, offline gap, socket frame;
 * - `milestone`: a moment worth a screenshot (route released, geofence
 *   flag, offline start/end, K12, cancel, K11, day finished);
 * - `info`: the simulation's own notes (where the log and the context went);
 * - `summary`: the last line, with the counters.
 *
 * The extra fields of an event or a milestone are spread after the line's
 * own, so they must not be called `kind`, `actor`, `type` or `name`: they
 * would replace them, and `kind` is what every reader filters by.
 */
interface LogLine {
  kind: "http" | "event" | "milestone" | "summary" | "info";
  actor: string;
  [field: string]: unknown;
}

class SimLog {
  private readonly stream: WriteStream;

  /** Calls that came back with an answer nobody planned for. */
  readonly unexpected: Array<Record<string, unknown>> = [];

  private readonly counters = new Map<string, number>();

  constructor(
    readonly path: string,
    private readonly clock: SimClock,
    private readonly echo: boolean = true,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: "w" });
  }

  private write(line: LogLine): void {
    const record = {
      wall: this.clock.wallIso(),
      sim: this.clock.simIso(),
      ...line,
    };

    this.stream.write(`${JSON.stringify(record)}\n`);
  }

  count(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  http(fields: {
    actor: string;
    replica: string;
    method: string;
    path: string;
    status: number;
    latencyMs: number;
    unexpected?: boolean;
    code?: string;
    message?: string;
    attempt?: number;
  }): void {
    this.count("http");
    this.count(`http.${Math.floor(fields.status / 100)}xx`);

    if (fields.unexpected) {
      this.unexpected.push({ ...fields, wall: this.clock.wallIso() });

      if (this.echo) {
        console.error(
          `[sim] INESPERADO ${fields.actor} ${fields.method} ${fields.path} → ${fields.status} ${fields.code ?? ""} ${fields.message ?? ""}`,
        );
      }
    }

    this.write({ kind: "http", ...fields });
  }

  event(
    actor: string,
    type: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.count(`event.${type}`);
    this.write({ kind: "event", actor, type, ...fields });
  }

  milestone(
    actor: string,
    name: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.count("milestone");
    this.write({ kind: "milestone", actor, name, ...fields });

    if (this.echo) {
      const detail = fields.route ? ` ${String(fields.route)}` : "";
      console.log(
        `[sim ${this.clock.simIso().slice(11, 19)}] ${name}${detail}`,
      );
    }
  }

  info(
    actor: string,
    message: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.write({ kind: "info", actor, message, ...fields });

    if (this.echo) console.log(`[sim] ${actor}: ${message}`);
  }

  /** Records an unexpected behaviour that is not an HTTP status (a finding). */
  anomaly(
    actor: string,
    what: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.unexpected.push({
      actor,
      what,
      ...fields,
      wall: this.clock.wallIso(),
    });
    this.write({ kind: "event", actor, type: "anomaly", what, ...fields });

    if (this.echo) console.error(`[sim] ANOMALIA ${actor}: ${what}`);
  }

  counterSnapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort());
  }

  async close(summary: Record<string, unknown>): Promise<void> {
    this.write({
      kind: "summary",
      actor: "sim",
      counters: this.counterSnapshot(),
      unexpected: this.unexpected,
      ...summary,
    });

    await new Promise<void>((done) => this.stream.end(done));
  }
}

export { SimLog };
