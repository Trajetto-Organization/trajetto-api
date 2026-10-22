import { env } from "@/env";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "ops-heartbeat" });

/**
 * The push half of the alerting (OBS-03): tell an external dead man's switch
 * how the system is, once a minute.
 *
 * healthchecks.io's convention, which Better Stack heartbeats and Cronitor
 * share: a request to the check's URL is "alive and well", to `<url>/fail`
 * is "alive and something is wrong" (the body is shown in the alert). The
 * check pages on /fail AND on silence — a dead process, a lost database, a
 * scheduler that stopped all look the same from outside: no ping. Uptime Kuma
 * push monitors use a query string instead; HEALTHCHECK_FAIL_URL covers them.
 *
 * The destination is deliberately NOT one of our own channels: the e-mail or
 * WhatsApp account that broke is exactly what this has to report.
 */

const REQUEST_TIMEOUT_MS = 5_000;

/** healthchecks.io keeps the first 100 kB of a body; ten is plenty to read. */
const MAX_BODY_BYTES = 10_000;

function failUrlOf(pingUrl: string): string {
  const url = new URL(pingUrl);

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/fail`;

  return url.toString();
}

/**
 * The job runs every minute; a condition that lasts an hour must not write
 * sixty identical warnings. A verdict is logged when it changes (numbers
 * ignored: a lag that grows is the same condition) and again every half hour
 * while it holds. The check itself still gets every minute's verdict.
 */
const REPEAT_LOG_MS = 30 * 60 * 1000;

let lastLogged: { key: string; at: number } | null = null;

function logVerdict(reasons: string[], now: number): void {
  if (reasons.length === 0) {
    if (lastLogged) log.info("operational check recovered");
    lastLogged = null;
    return;
  }

  const key = reasons.map((reason) => reason.replace(/\d+/g, "#")).join("\n");

  if (
    lastLogged &&
    lastLogged.key === key &&
    now - lastLogged.at < REPEAT_LOG_MS
  ) {
    return;
  }

  log.warn({ reasons }, "operational check failed");
  lastLogged = { key, at: now };
}

function truncate(text: string): string {
  const bytes = Buffer.from(text, "utf8");

  return bytes.length <= MAX_BODY_BYTES
    ? text
    : `${bytes.subarray(0, MAX_BODY_BYTES).toString("utf8")}\n…`;
}

/** Kuma shows `msg` in its notifications; a URL has room for a summary only. */
const MAX_QUERY_MESSAGE = 500;

/**
 * An explicit HEALTHCHECK_FAIL_URL is an Uptime Kuma push URL
 * (`?status=down`). Kuma reads status and msg from the QUERY and ignores the
 * body, and its 1.23 line routes only GET on /api/push/:token: the POST the
 * healthchecks.io convention gets was a 404 there, and the check only went
 * down later, through the silence, with no reason attached. So: GET, reasons
 * summarised in `msg`. GET also works on healthchecks.io, Better Stack and
 * Cronitor failure URLs, should one be set here instead.
 */
function withMessage(failUrl: string, reasons: string[]): string {
  const url = new URL(failUrl);
  const summary = reasons.join(" | ");

  url.searchParams.set(
    "msg",
    summary.length <= MAX_QUERY_MESSAGE
      ? summary
      : `${summary.slice(0, MAX_QUERY_MESSAGE - 1)}…`,
  );

  return url.toString();
}

/**
 * Sends one heartbeat. Never throws: the check being unreachable must not
 * turn into a failed cron run (it would only add noise to the table the
 * alert reads); the missing ping is already what pages.
 *
 * The URLs carry the check's secret: they are never logged.
 */
/**
 * What this replica's last ping did, for /health/providers: the cron
 * election picks one replica per minute, so another replica may know a more
 * recent one. Never the URL.
 */
interface HeartbeatOutcome {
  at: string;
  healthy: boolean;
  delivered: boolean;
  http_status: number | null;
}

let lastOutcome: HeartbeatOutcome | null = null;

function lastHeartbeatOutcome(): HeartbeatOutcome | null {
  return lastOutcome;
}

async function sendHeartbeat(reasons: string[]): Promise<void> {
  const pingUrl = env.HEALTHCHECK_PING_URL;

  logVerdict(reasons, Date.now());

  if (!pingUrl) return;

  const healthy = reasons.length === 0;
  const remember = (delivered: boolean, status: number | null) => {
    lastOutcome = {
      at: new Date().toISOString(),
      healthy,
      delivered,
      http_status: status,
    };
  };
  const explicitFailUrl = env.HEALTHCHECK_FAIL_URL;

  try {
    const response = healthy
      ? await fetch(pingUrl, {
          method: "GET",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      : explicitFailUrl
        ? await fetch(withMessage(explicitFailUrl, reasons), {
            method: "GET",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
        : await fetch(failUrlOf(pingUrl), {
            method: "POST",
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body: truncate(reasons.join("\n")),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });

    remember(response.ok, response.status);

    if (!response.ok) {
      log.warn(
        { status: response.status, healthy },
        "heartbeat check answered an error",
      );
    }
  } catch (error) {
    remember(false, null);

    log.warn(
      { err: error instanceof Error ? error.message : String(error), healthy },
      "heartbeat check unreachable",
    );
  }
}

export { failUrlOf, lastHeartbeatOutcome, sendHeartbeat };
export type { HeartbeatOutcome };
