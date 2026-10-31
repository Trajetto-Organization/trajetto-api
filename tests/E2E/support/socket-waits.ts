import type { Server as SocketIOServer } from "socket.io";

/**
 * Waiting on a state of the realtime server, never on a number of
 * milliseconds.
 *
 * The socket files slept 400 ms to 2.5 s after a subscribe, a permission
 * change or a demotion, guessing how long the server's database read took.
 * Under a loaded runner that guess is wrong in both directions: a positive
 * case reads a join that has not happened yet as "never delivered", and a
 * negative case passes for the wrong reason. These wait for what the test
 * actually depends on, with a deadline generous enough to only ever be hit by
 * a real defect.
 */
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_MS = 25;

interface EmittingSocket {
  emit: (...args: unknown[]) => unknown;
}

interface ClientSocket {
  connected: boolean;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/**
 * Emits and resolves once the server acknowledged it. websocket.ts answers
 * `chatSubscribe` and `operationsSubscribe` with an empty acknowledgement
 * when the subscribe was handled — joined or refused alike, so the order of
 * a test's next step no longer depends on the database's speed.
 */
function emitHandled(
  socket: EmittingSocket,
  event: string,
  payload: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`tempo esgotado esperando o servidor tratar ${event}`),
        ),
      timeoutMs,
    );

    socket.emit(event, payload, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Polls until `holds` is true, or fails saying what it waited for. */
async function waitUntil(
  holds: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error(`tempo esgotado: ${what}`);

    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

/**
 * Until a socket of THIS process's server is in (or out of) a room, read
 * from the server's own room index — the same one every emit uses.
 */
function waitForRoom(
  io: SocketIOServer,
  socketId: string,
  room: string,
  inside: boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return waitUntil(
    () =>
      (io.of("/").adapter.rooms.get(room)?.has(socketId) ?? false) === inside,
    `o socket ${inside ? "entrar na" : "sair da"} sala ${room}`,
    timeoutMs,
  );
}

/**
 * Until a room has `count` sockets across the cluster: `fetchSockets` goes
 * through the Redis adapter to every replica, so it sees the sockets a
 * replica process holds.
 */
function waitForRoomSize(
  io: SocketIOServer,
  room: string,
  count: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return waitUntil(
    async () => (await io.in(room).fetchSockets()).length === count,
    `a sala ${room} ter ${count} socket(s)`,
    timeoutMs,
  );
}

/** Until the client is disconnected (by the server, in these tests). */
function waitForDisconnect(
  socket: ClientSocket,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (!socket.connected) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("tempo esgotado esperando a desconexão")),
      timeoutMs,
    );

    socket.once("disconnect", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export {
  emitHandled,
  waitForDisconnect,
  waitForRoom,
  waitForRoomSize,
  waitUntil,
};
