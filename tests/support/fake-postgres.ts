import net from "node:net";
import util from "node:util";

/**
 * A TCP server that speaks just enough of the Postgres wire protocol to fail
 * on cue, so the API's real driver stack — pg, pg-pool, the pool of
 * src/shared/database/pg-driver.ts, @prisma/adapter-pg and Prisma — raises
 * its real errors without a database.
 *
 * - `silent`: accepts the connection and never answers (a host that hangs).
 * - `close-on-startup`: reads the startup message and closes the socket.
 * - `refuse`: answers the startup message with a FATAL ErrorResponse carrying
 *   `sqlState`, as Postgres does for "too many connections" (53300).
 * - `ready`: completes the handshake (no password), then on the first query
 *   closes the socket (`onQuery: "close"`) or never answers (`"ignore"`).
 */
type FakePostgresBehaviour =
  | { kind: "silent" }
  | { kind: "close-on-startup" }
  | { kind: "refuse"; sqlState: string; message: string }
  | { kind: "ready"; onQuery: "close" | "ignore" };

interface FakePostgres {
  /** A connection URL for it; add the pool parameters a test needs. */
  url: string;

  /** Sockets currently open against it. */
  connections(): number;

  close(): Promise<void>;
}

function message(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);

  return Buffer.concat([Buffer.from(type), length, body]);
}

const AUTHENTICATION_OK = message("R", Buffer.from([0, 0, 0, 0]));
const READY_FOR_QUERY = message("Z", Buffer.from("I"));

function errorResponse(sqlState: string, text: string): Buffer {
  const field = (code: string, value: string) =>
    Buffer.concat([Buffer.from(code), Buffer.from(value), Buffer.from([0])]);

  return message(
    "E",
    Buffer.concat([
      field("S", "FATAL"),
      field("V", "FATAL"),
      field("C", sqlState),
      field("M", text),
      Buffer.from([0]),
    ]),
  );
}

async function fakePostgres(
  behaviour: FakePostgresBehaviour,
): Promise<FakePostgres> {
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});

    if (behaviour.kind === "silent") return;

    let received = Buffer.alloc(0);
    let startedUp = false;

    socket.on("data", (chunk: Buffer) => {
      if (startedUp) {
        // Anything after the handshake is a query.
        if (behaviour.kind === "ready" && behaviour.onQuery === "close") {
          socket.destroy();
        }

        return;
      }

      // The startup message has no type byte: a length, then the rest.
      received = Buffer.concat([received, chunk]);

      if (received.length < 4 || received.length < received.readInt32BE(0)) {
        return;
      }

      startedUp = true;

      if (behaviour.kind === "close-on-startup") {
        socket.destroy();
      } else if (behaviour.kind === "refuse") {
        socket.end(errorResponse(behaviour.sqlState, behaviour.message));
      } else {
        socket.write(Buffer.concat([AUTHENTICATION_OK, READY_FOR_QUERY]));
      }
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );

  const { port } = server.address() as net.AddressInfo;
  let closing: Promise<void> | undefined;

  return {
    url: `postgresql://fake:fake@127.0.0.1:${port}/fake`,
    connections: () => sockets.size,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();

        server.close(() => resolve());
      });

      return closing;
    },
  };
}

/** A local port nothing listens on: connecting to it is refused at once. */
async function closedPort(): Promise<number> {
  const server = net.createServer();

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );

  const { port } = server.address() as net.AddressInfo;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

/**
 * A socket error as Node raises it: the platform's own errno number for
 * `code` (from libuv's table, so EHOSTUNREACH carries this OS's value) and
 * Node's message format, `<syscall> <code> [<target>]`.
 */
function systemError(
  code: string,
  syscall: string,
  target?: string,
): NodeJS.ErrnoException {
  // Node reports getaddrinfo's EAI_NONAME as ENOTFOUND, keeping its errno.
  const name = code === "ENOTFOUND" ? "EAI_NONAME" : code;
  const entry = [...util.getSystemErrorMap()].find(
    ([, [errnoName]]) => errnoName === name,
  );

  if (!entry) throw new Error(`${code} is not an errno on this platform`);

  return Object.assign(
    new Error(target ? `${syscall} ${code} ${target}` : `${syscall} ${code}`),
    { code, errno: entry[0], syscall },
  );
}

export { closedPort, fakePostgres, systemError };
export type { FakePostgres, FakePostgresBehaviour };
