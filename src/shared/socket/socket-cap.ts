import { readFileSync } from "node:fs";

/**
 * How many sockets this replica may really hold (plano-escala F5-31).
 *
 * Every websocket is a file descriptor, and so is every Postgres
 * connection, every Redis client, every HTTP keep-alive and every file the
 * process opens. SOCKET_MAX_CONNECTIONS (U-01) said 5,000 whatever the
 * process was allowed: under a descriptor limit lower than that, the
 * sockets would take the last descriptors and the next Postgres connect or
 * upload would fail with EMFILE, an outage of the whole replica instead of a
 * refused handshake. So the ceiling is the smaller of the setting and the
 * descriptor limit minus a reserve (SOCKET_FD_RESERVE, 1,024) for
 * everything that is not a socket:
 *
 *   socket_cap = min(SOCKET_MAX_CONNECTIONS, fd_soft − SOCKET_FD_RESERVE)
 *
 * The soft limit is read once, at boot, from /proc/self/limits: Node raises
 * its soft limit to the hard one when it starts, so the file says what the
 * process ended up with, which `ulimit -n` in a shell does not. Off Linux,
 * or unreadable, only the setting applies. A limit so low that the reserve
 * would leave fewer than 1,024 sockets is a misconfigured host, and turning
 * it into a ceiling would refuse realtime on its own: the descriptor part is
 * left out and the boot warns instead (`fdTooLow`).
 */

/** Below this, the descriptor part of the ceiling is not applied. */
const FD_CAP_MIN = 1_024;

/** "Max open files  <soft>  <hard>  files" in /proc/<pid>/limits. */
const OPEN_FILES_LINE =
  /^Max open files\s+(\d+|unlimited)\s+(\d+|unlimited)\s+files\s*$/m;

/** The soft limit in a /proc/<pid>/limits text; null when unlimited or absent. */
function parseOpenFilesSoftLimit(limits: string): number | null {
  const match = OPEN_FILES_LINE.exec(limits);

  if (!match || match[1] === "unlimited") return null;

  const soft = Number(match[1]);

  return Number.isSafeInteger(soft) && soft > 0 ? soft : null;
}

/** This process's soft descriptor limit; null off Linux or unreadable. */
function readOpenFilesSoftLimit(
  read: () => string = () => readFileSync("/proc/self/limits", "utf8"),
): number | null {
  try {
    return parseOpenFilesSoftLimit(read());
  } catch {
    return null;
  }
}

interface SocketCap {
  /** The ceiling the admission applies; 0 when none applies. */
  cap: number;

  /** The process's soft descriptor limit, as read; null when unknown. */
  fdLimit: number | null;

  /** Which part set the ceiling. */
  source: "connections" | "descriptors" | "off";

  /** The limit is known but too low for the reserve: the boot warns. */
  fdTooLow: boolean;
}

function effectiveSocketCap({
  maxConnections,
  fdLimit,
  fdReserve,
}: {
  maxConnections: number;
  fdLimit: number | null;
  fdReserve: number;
}): SocketCap {
  const fromDescriptors =
    fdReserve > 0 && fdLimit !== null ? fdLimit - fdReserve : null;

  const fdTooLow = fromDescriptors !== null && fromDescriptors < FD_CAP_MIN;
  const fdCap = fromDescriptors !== null && !fdTooLow ? fromDescriptors : null;

  if (maxConnections > 0 && fdCap !== null) {
    return fdCap < maxConnections
      ? { cap: fdCap, fdLimit, source: "descriptors", fdTooLow }
      : { cap: maxConnections, fdLimit, source: "connections", fdTooLow };
  }

  if (maxConnections > 0) {
    return { cap: maxConnections, fdLimit, source: "connections", fdTooLow };
  }

  if (fdCap !== null) {
    return { cap: fdCap, fdLimit, source: "descriptors", fdTooLow };
  }

  return { cap: 0, fdLimit, source: "off", fdTooLow };
}

export {
  FD_CAP_MIN,
  effectiveSocketCap,
  parseOpenFilesSoftLimit,
  readOpenFilesSoftLimit,
};
export type { SocketCap };
