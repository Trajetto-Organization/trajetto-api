/**
 * The order a replica comes up in, kept apart from `server.ts` so it can be
 * tested without booting the application — the mirror of shutdown.ts.
 *
 * 0. CERTIFICATES: the proof signing A1 is opened and its state logged
 *    (design §6.3 of the ICP proof), so a bad PFX or password shows up in
 *    the deploy log instead of on the first receipt. It never stops the boot:
 *    a broken certificate means unsigned documents, not a down API.
 * 1. WORKERS, without draining. Timers and cron are armed before the first
 *    request can enqueue work for them.
 * 2. HTTP.
 * 3. REALTIME: the Socket.IO server and its Redis adapter.
 * 4. The BACKLOG, last. What piled up while the replica was down (a deploy)
 *    is delivered only once realtime exists: drained earlier, every in-app
 *    notification in it reached the bell with no toast — `io` did not exist
 *    yet on this replica, and the adapter that reaches the others did not
 *    either (OUTBOX-19). A realtime that fails to start fails the boot before
 *    anything is drained.
 *
 * The emit itself stays at-most-once by design (ADR 0003): a crash between
 * the notification insert and the emit loses the toast, never the
 * notification — the bell is the source of truth.
 */
interface StartupSteps {
  /** Opens and logs the signing certificates. Must not throw; if it does, the boot goes on. */
  inspectCertificates?: () => void;

  /** Timers, cron and the pipelines — armed, not drained. */
  startWorkers: () => Promise<void>;

  listen: () => Promise<void>;

  /** Socket.IO and its Redis adapter. */
  startRealtime: () => Promise<void>;

  /** Delivers what accumulated while the replica was down. */
  drainBacklog: () => void;
}

async function runStartup(steps: StartupSteps): Promise<void> {
  try {
    steps.inspectCertificates?.();
  } catch {
    // The inspection only informs; the proof route reads the state again.
  }

  await steps.startWorkers();
  await steps.listen();
  await steps.startRealtime();

  steps.drainBacklog();
}

export { runStartup, type StartupSteps };
