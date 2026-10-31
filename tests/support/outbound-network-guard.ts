import net from "node:net";

/**
 * No test reaches beyond this machine.
 *
 * Decision D7 of the CI audit (30/10/2026): a pipeline may fail only on a
 * defect of the code, and a test that talks to a third party fails whenever
 * the third party does. Ethereal was the case that proved it — every E2E run
 * that sent an e-mail created a test account at api.nodemailer.com and opened
 * an SMTP session with smtp.ethereal.email, and nothing said so. This makes
 * the rule a check instead of a habit: every TCP connection a test file
 * opens goes to the loopback, or to the hosts of the databases it was given
 * and of the local doubles it was pointed at (DATABASE_URL,
 * TEST_DATABASE_URL, REDIS_URL, REDIS_HOST, AI_LOCAL_URL,
 * MINIO_TEST_ENDPOINT).
 * Anything else is refused before any DNS lookup — or, when the caller
 * brings its own lookup, by the address that lookup answers — and the file
 * fails at the end with the list, also when the connection was
 * fire-and-forget and no assertion would have noticed.
 *
 * At the socket, not at `fetch`: undici, node:http, node:https, SMTP and the
 * database drivers all connect through `net.Socket.prototype.connect`. The
 * child processes a test starts (the replicas) do not load this; they point
 * every provider at the test's local fake instead (pipeline-replica.ts).
 */
const LOOPBACK_NAMES = new Set(["localhost", "0.0.0.0", "::", "::1"]);

/**
 * Kept on the process, not in this module: a worker runs many test files and
 * evaluates this module again for each one, while `node:net` is the same.
 * Patched once, and every file reads the same list of refusals.
 */
const STATE = Symbol.for("trajetto.tests.outbound-network-guard");

interface GuardState {
  blocked: string[];
}

function state(): GuardState | undefined {
  return (globalThis as { [STATE]?: GuardState })[STATE];
}

function hostOf(value: string | undefined): string | null {
  if (!value) return null;

  try {
    return new URL(value).hostname.replace(/^\[(.*)\]$/, "$1") || null;
  } catch {
    return null;
  }
}

/** The database hosts the run was configured with: a remote one is allowed. */
function configuredHosts(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    [
      hostOf(env.DATABASE_URL),
      hostOf(env.TEST_DATABASE_URL),
      hostOf(env.REDIS_URL),
      hostOf(env.AI_LOCAL_URL),
      hostOf(env.MINIO_TEST_ENDPOINT),
      env.REDIS_HOST || null,
    ].filter((host): host is string => Boolean(host)),
  );
}

function isLoopback(host: string): boolean {
  const bare = host.toLowerCase().replace(/^::ffff:/, "");

  return LOOPBACK_NAMES.has(bare) || /^127\./.test(bare);
}

interface Target {
  host: string;
  port: unknown;
}

/**
 * Where a `connect` call goes, in the shapes Node passes it: the normalized
 * `[options, callback]` array net.connect hands over, an options object, or
 * `(port, host)`. A path (a Unix socket or a named pipe) is local by
 * definition and returns null.
 */
function targetOf(args: unknown[]): Target | null {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];

  if (typeof first === "number" || typeof first === "string") {
    if (typeof first === "string" && !/^\d+$/.test(first)) return null;

    return {
      host: typeof args[1] === "string" ? args[1] : "localhost",
      port: first,
    };
  }

  if (first && typeof first === "object") {
    const options = first as { host?: unknown; port?: unknown; path?: unknown };

    if (typeof options.path === "string") return null;

    return {
      host: typeof options.host === "string" ? options.host : "localhost",
      port: options.port,
    };
  }

  return null;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

type Lookup = (
  hostname: string,
  options: unknown,
  callback: LookupCallback,
) => void;

/** The options object of a `connect` call, when it was given one. */
function optionsOf(args: unknown[]): Record<string, unknown> | null {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];

  return first && typeof first === "object"
    ? (first as Record<string, unknown>)
    : null;
}

function refusal(where: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(
      `Conexão de teste para fora da máquina recusada (${where}): use um dublê local (decisão D7, docs/testes.md).`,
    ),
    { code: "ECONNREFUSED" },
  );
}

function installOutboundNetworkGuard(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (state()) return;

  const guard: GuardState = { blocked: [] };

  (globalThis as { [STATE]?: GuardState })[STATE] = guard;

  const allowed = (host: string) =>
    isLoopback(host) || configuredHosts(env).has(host);

  const original = net.Socket.prototype.connect;

  net.Socket.prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ) {
    const target = targetOf(args);

    if (target && !allowed(target.host)) {
      const options = optionsOf(args);

      // A caller that resolves the name itself decides where the socket
      // goes: webhook-destination.ts hands it the address it validated, and
      // webhook-dns-rebinding.test.ts answers that lookup with a local
      // address under a made-up name. The address is what is judged then.
      if (options && typeof options.lookup === "function") {
        const lookup = options.lookup as Lookup;

        options.lookup = ((hostname, lookupOptions, callback) =>
          lookup(hostname, lookupOptions, (error, address, family) => {
            if (error) return callback(error, address, family);

            const addresses = Array.isArray(address)
              ? address.map((entry) => entry.address)
              : [address];
            const outside = addresses.find((entry) => !allowed(entry));

            if (outside === undefined) return callback(null, address, family);

            const where = `${hostname} (${outside}):${String(target.port)}`;

            guard.blocked.push(where);
            callback(refusal(where), "");
          })) as Lookup;

        return (original as (...a: unknown[]) => net.Socket).apply(this, args);
      }

      const where = `${target.host}:${String(target.port)}`;

      guard.blocked.push(where);

      // Asynchronous, as a refused connection is: callers attach their
      // 'error' listener after connect() returns.
      process.nextTick(() => this.destroy(refusal(where)));

      return this;
    }

    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}

/** The refused connections since the last call, and forgets them. */
function takeBlockedConnections(): string[] {
  return state()?.blocked.splice(0) ?? [];
}

export {
  configuredHosts,
  installOutboundNetworkGuard,
  isLoopback,
  takeBlockedConnections,
  targetOf,
};
