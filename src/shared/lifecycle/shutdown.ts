/**
 * The order a replica goes away in, kept apart from `server.ts` so it can be
 * tested without booting the application.
 *
 * Each step exists because its absence was observed:
 *
 * 1. DRAIN FIRST. Readiness answered 200 until the very end, so the load
 *    balancer kept routing new requests to a replica that was about to close
 *    its listener. Readiness now answers 503 from the first instant, and the
 *    replica keeps serving for one health-check interval while Traefik takes
 *    it out of rotation.
 * 2. REALTIME BEFORE HTTP. An upgraded websocket keeps the HTTP server open,
 *    and nothing closed them: `app.close()` waited forever with a single
 *    driver connected — which in production is always — until the watchdog
 *    killed the process mid-send. Closing the Socket.IO engine ends them with
 *    "transport close", which the clients answer by reconnecting to another
 *    replica.
 * 3. HTTP, then WORKERS. In-flight requests finish against live services.
 * 4. REDIS LAST. Nothing publishes after the workers stopped.
 */
interface ShutdownSteps {
  /** Readiness starts answering 503. */
  markDraining: () => void;

  /** How long to keep serving after readiness flips; 0 outside production. */
  drainMs: number;

  /** Ends every websocket so the HTTP server can close. */
  closeRealtime: () => void;

  closeHttp: () => Promise<void>;
  stopWorkers: () => Promise<void>;
  closeRedis: () => Promise<void>;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runShutdown(
  steps: ShutdownSteps,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<void> {
  steps.markDraining();

  if (steps.drainMs > 0) await sleep(steps.drainMs);

  steps.closeRealtime();

  await steps.closeHttp();
  await steps.stopWorkers();
  await steps.closeRedis();
}

export { runShutdown, type ShutdownSteps };
