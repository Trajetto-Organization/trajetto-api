import {
  sweepConnections,
  type SocketSubject,
  type SubjectRows,
  type SweepActions,
  type SweepResult,
  type SweptSocket,
} from "./socket-revalidation";

/**
 * The handshake's verdict, read again once the socket is in its rooms.
 *
 * `io.use` reads the session over several round trips, and Socket.IO joins
 * rooms only after `next()` and a `process.nextTick`. Until then the socket
 * is in no room and not in `nsp.sockets`, so a revocation committed after
 * those reads and announced before the join reached nothing: the frame found
 * no room, `disconnectSockets` found no socket, the room refresh found no one
 * to re-read. The socket then connected with the rights it had BEFORE the
 * revocation — the web's dispatch rooms included — and lived until the
 * periodic sweep, up to 225 s later.
 *
 * Reading again AFTER the joins closes that gap on any number of replicas: a
 * revocation committed before this read is seen here, and one committed after
 * it is announced (always after its commit, ADR 0007) to rooms the socket is
 * already in.
 *
 * The verdict is the sweep's, through the same function, so the two cannot
 * disagree: an ended session is told why and dropped, a lost dispatch right
 * leaves the dispatch rooms and keeps the connection (keepAdmitted, below).
 * And it fails OPEN like the sweep: a read that fails ends nobody — a
 * server-side disconnect is final in socket.io-client — and leaves the case
 * to the next pass of the sweep.
 *
 * It reads the primary, like the sweep. Pointed at a read replica of
 * Postgres, a revocation committed before this read could still be missing
 * from it, and the gap would be open again with no test to say so.
 *
 * Coalesced per replica: at most one load in flight, and a socket admitted
 * while it runs waits for the next one, whose read starts after it joined. A
 * burst of reconnects — a replica restarting, a network coming back — costs
 * one bulk read, like a sweep, not one per socket.
 */
interface AdmissionRecheckOptions<S extends SweptSocket> {
  load: (subjects: SocketSubject[]) => Promise<SubjectRows>;
  actions: SweepActions<S>;

  /** After every pass, with how many sockets it was given. */
  report?: (result: SweepResult, admitted: number) => void;

  /** A pass that threw — an action or the report, never the read. */
  fail?: (error: unknown) => void;
}

interface AdmissionRecheck<S extends SweptSocket> {
  /** Call once the socket is in every room it joins at connect. */
  admit(socket: S): void;
}

function createAdmissionRecheck<S extends SweptSocket>(
  options: AdmissionRecheckOptions<S>,
): AdmissionRecheck<S> {
  let queue: S[] = [];
  let draining = false;

  async function drain(): Promise<void> {
    draining = true;

    try {
      while (queue.length > 0) {
        // Taken whole: anyone admitted from here on is read by the next load,
        // which starts after they joined. Whoever already left needs no read.
        const batch = queue.filter((socket) => socket.connected);
        queue = [];

        try {
          const result = await sweepConnections(
            batch,
            options.load,
            options.actions,
          );

          options.report?.(result, batch.length);
        } catch (error) {
          // One pass that threw must not leave the next ones waiting for an
          // admission that may not come.
          options.fail?.(error);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    admit(socket) {
      queue.push(socket);

      // Only a `fail` that itself threw gets here; an unhandled rejection
      // would end the process (Node 22), and the next admission drains on.
      if (!draining) void drain().catch(() => undefined);
    },
  };
}

/**
 * What the recheck does with a session it keeps. Not the sweep's `keep`, for
 * two reasons.
 *
 * It only ever takes the dispatch right away. Its rows may predate a removal
 * announced while they were being read — the socket was in its company's
 * room by then, so the room refresh took it out — and a verdict read before
 * that commit must not set `isDeliveryStaff` back on: the flag alone opens
 * the SAC's typing hints to the company's drivers, until the sweep. A right
 * gained in that window needs nothing here: the screen that wants a room
 * subscribes, and the subscribe reads the database itself.
 *
 * And it says so. A loss caught here was announced (`permissions_changed`,
 * to the company's room or the user's) before this socket was in any room:
 * the client never heard it, and its screen would keep the menus of the old
 * right over a feed gone quiet. So the announcement is made again, once, when the
 * handshake granted the right and nothing took it back since. The web
 * re-reads /user/me on it, the app too, and neither ends the session.
 */
function keepAdmitted<S extends SweptSocket>(
  leaveDispatch: (socket: S) => void,
  tell: (socket: S, reason: string) => void,
): SweepActions<S>["keep"] {
  return (socket, isDeliveryStaff) => {
    if (isDeliveryStaff) return;

    if (socket.data.isDeliveryStaff === true) {
      tell(socket, "permissions_changed");
    }

    leaveDispatch(socket);
  };
}

export { createAdmissionRecheck, keepAdmitted };
export type { AdmissionRecheck, AdmissionRecheckOptions };
