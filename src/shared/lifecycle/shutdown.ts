import { settlesWithin } from "./deadline";

/**
 * The order a replica goes away in, kept apart from `server.ts` so it can be
 * tested without booting the application.
 *
 * Each step exists because its absence was observed:
 *
 * 1. DRAIN FIRST. Readiness answered 200 until the very end, so the load
 *    balancer kept routing new requests to a replica that was about to close
 *    its listener. Readiness now answers 503 from the first instant, and the
 *    replica keeps serving for the plan's drain (shutdown-plan.ts). Traefik
 *    has no health check on the service (docs/deploy.md, section 5): the
 *    Swarm takes the task out of the virtual address before the SIGTERM, and
 *    the drain is for the requests on the keep-alive connections Traefik
 *    still holds with it.
 * 2. REALTIME BEFORE HTTP. An upgraded websocket keeps the HTTP server open,
 *    and nothing closed them: `app.close()` waited forever with a single
 *    driver connected — which in production is always — until the watchdog
 *    killed the process mid-send. Closing the Socket.IO engine ends them with
 *    "transport close", which the clients answer by reconnecting to another
 *    replica.
 * 3. HTTP, then WORKERS. In-flight requests finish against live services,
 *    within the plan's `httpMs`. `app.close()` waits for every one of them
 *    and has no deadline of its own (a body may take 120 s to arrive): an
 *    old app build sending a photo through the multipart adapter on a slow
 *    3G link held it until the watchdog's exit(1), before the workers had
 *    stopped — a cron run left RUNNING, the batches back to their leases.
 *    Past the deadline the connections still open are closed (the client
 *    sees its request fail and sends it again, as it would after the
 *    watchdog), and the workers stop inside the grace.
 * 4. REDIS LAST. Nothing publishes after the workers stopped.
 *
 * Alongside, from the first instant: the in-process IMPORT QUEUE
 * (import-queue.ts). A deploy dropped the running spreadsheet upload and up
 * to three waiting ones that had already been answered 202, and the user
 * only learned it 15–20 minutes later, from the abandoned-import sweep. The
 * queue now refuses new uploads, hands the waiting ones back at once, and
 * gives the running one the drain window (and a little more) before asking
 * it to stop at a row boundary. It is awaited before the workers stop, so
 * every record it closes is written while the process is still whole.
 */
interface ShutdownSteps {
  /** Readiness starts answering 503. */
  markDraining: () => void;

  /**
   * How long to keep serving after readiness flips (the shutdown plan's
   * drain); 0 outside production.
   */
  drainMs: number;

  /**
   * Stops the import queue (ImportQueue.drain): started with the drain,
   * settled once every upload on this replica finished or was handed back.
   * Never rejects; the queue logs what it could not write.
   */
  drainImports: () => Promise<void>;

  /** Ends every websocket so the HTTP server can close. */
  closeRealtime: () => void;

  /**
   * Stops accepting connections and settles once every request in flight
   * has been answered (Fastify's close).
   */
  closeHttp: () => Promise<void>;

  /**
   * How long the requests still in flight get once the drain is over (the
   * plan's httpMs); past it, `cutHttp`.
   */
  httpMs: number;

  /** Ends every HTTP connection still open, in flight or not. */
  cutHttp: () => void;

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

  // Not awaited yet: the running upload uses the drain window to finish.
  const imports = steps.drainImports().catch(() => undefined);

  if (steps.drainMs > 0) await sleep(steps.drainMs);

  steps.closeRealtime();

  const closing = steps.closeHttp();

  if (!(await settlesWithin(closing, steps.httpMs))) steps.cutHttp();

  await closing;
  await imports;
  await steps.stopWorkers();
  await steps.closeRedis();
}

export { runShutdown, type ShutdownSteps };
