import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Where the load scripts borrow `socket.io-client` from.
 *
 * The API is a server and has no client among its dependencies — a test-only
 * dependency in the production package is one somebody ends up importing in
 * production — so the client comes from the web repository next to it.
 *
 * The one resolver: the socket E2E tests import it too, through
 * tests/E2E/support/socket-client.ts (typed by socket-client.d.mts). The web
 * folder was renamed from `trajetto-fleet-manager-ui` to `trajetto-ui`, and a
 * second copy here kept the old name, so step 3 of multi-replica.sh died on
 * the import. Both names are tried, and SOCKET_IO_CLIENT_ENTRY overrides them.
 */
const API_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const CANDIDATE_REPOSITORIES = ["trajetto-ui", "trajetto-fleet-manager-ui"];

function socketClientEntry({
  env = process.env,
  root = API_ROOT,
  exists = existsSync,
} = {}) {
  if (env.SOCKET_IO_CLIENT_ENTRY) return pathToFileURL(resolve(env.SOCKET_IO_CLIENT_ENTRY)).href;

  for (const repository of CANDIDATE_REPOSITORIES) {
    const entry = resolve(
      root,
      "..",
      repository,
      "node_modules",
      "socket.io-client",
      "build",
      "esm",
      "index.js",
    );

    if (exists(entry)) return pathToFileURL(entry).href;
  }

  throw new Error(
    "socket.io-client não encontrado: instale as dependências de ../trajetto-ui " +
      "ou aponte SOCKET_IO_CLIENT_ENTRY para build/esm/index.js do pacote.",
  );
}

/** The client's `io`, from wherever socketClientEntry found it. */
async function loadSocketClient(options) {
  const { io } = await import(socketClientEntry(options));

  return io;
}

export { loadSocketClient, socketClientEntry };
