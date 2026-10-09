import { Writable } from "node:stream";

import type * as LoggerModule from "@/shared/logging/logger";

/**
 * What the shared pino logger wrote, as the JSON lines a log shipper reads.
 *
 * Spying on the root logger does not work for the workers: they take
 * `logger.child({ component })` when they load, and pino gives every child
 * its own level methods. So the test swaps the root for a real one built by
 * `buildLogger` over an in-memory stream — children included, every line is
 * serialized exactly as in production (the `err` serializer, redaction) and
 * lands here:
 *
 *   vi.mock("@/shared/logging/logger", async (importOriginal) =>
 *     (await import("../../support/log-capture")).capturingLogger(
 *       await importOriginal(),
 *     ),
 *   );
 */
interface LogLine {
  level: number;
  msg?: string;
  component?: string;
  err?: { type?: string; message?: string; stack?: string };
  [field: string]: unknown;
}

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;

const lines: LogLine[] = [];

const sink = new Writable({
  write(chunk, _encoding, done) {
    for (const text of String(chunk).split("\n")) {
      if (text.trim()) lines.push(JSON.parse(text) as LogLine);
    }

    done();
  },
});

/** The logger module a `vi.mock` factory returns: the real one, capturing. */
function capturingLogger(actual: unknown): typeof LoggerModule {
  const real = actual as typeof LoggerModule;
  const logger = real.buildLogger(sink);

  // Debug lines too, whatever LOG_LEVEL the test environment has.
  logger.level = "debug";

  return { ...real, logger };
}

/** Lines written since the last `clearLogged()`, optionally of one level. */
function logged(level?: keyof typeof LEVELS): LogLine[] {
  return level
    ? lines.filter((line) => line.level === LEVELS[level])
    : [...lines];
}

function clearLogged(): void {
  lines.length = 0;
}

export { capturingLogger, clearLogged, logged };
export type { LogLine };
