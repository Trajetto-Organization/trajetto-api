/**
 * Types for socket-client.mjs, the one resolver of `socket.io-client` shared
 * by the load scripts and the socket E2E tests (tests/E2E/support).
 */
interface SocketClientEntryOptions {
  env?: Record<string, string | undefined>;
  root?: string;
  exists?: (path: string) => boolean;
}

/** The file URL of socket.io-client's ESM build, from the web repository. */
export function socketClientEntry(options?: SocketClientEntryOptions): string;

/** The client's `io`, from wherever socketClientEntry found it. */
export function loadSocketClient(options?: SocketClientEntryOptions): Promise<unknown>;
