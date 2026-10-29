import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Where the load scripts and the socket E2E tests get `socket.io-client`.
 *
 * First from the API's own node_modules: it is a devDependency here, pinned
 * to the version the web ships, so the API's E2E suite runs on a checkout of
 * this repository alone — CI has no web checkout next to it. A devDependency
 * never reaches the image (the runtime stage installs `--production=true`).
 *
 * Then from the web repository next to this one, for an install made with
 * `--production`: `trajetto-ui`, and the folder's old name
 * `trajetto-fleet-manager-ui` (a second copy of this resolver kept the old
 * name once, and step 3 of multi-replica.sh died on the import).
 *
 * SOCKET_IO_CLIENT_ENTRY overrides all of them.
 *
 * The one resolver: the socket E2E tests import it too, through
 * tests/E2E/support/socket-client.ts (typed by socket-client.d.mts).
 */
const API_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const CANDIDATE_REPOSITORIES = ["trajetto-ui", "trajetto-fleet-manager-ui"];

const ENTRY = ["socket.io-client", "build", "esm", "index.js"];

function socketClientEntry({
  env = process.env,
  root = API_ROOT,
  exists = existsSync,
} = {}) {
  if (env.SOCKET_IO_CLIENT_ENTRY)
    return pathToFileURL(resolve(env.SOCKET_IO_CLIENT_ENTRY)).href;

  const candidates = [
    resolve(root, "node_modules", ...ENTRY),
    ...CANDIDATE_REPOSITORIES.map((repository) =>
      resolve(root, "..", repository, "node_modules", ...ENTRY),
    ),
  ];

  for (const entry of candidates) {
    if (exists(entry)) return pathToFileURL(entry).href;
  }

  throw new Error(
    "socket.io-client não encontrado: rode `yarn install` nesta API (é devDependency), " +
      "instale as dependências de ../trajetto-ui " +
      "ou aponte SOCKET_IO_CLIENT_ENTRY para build/esm/index.js do pacote.",
  );
}

/** The client's `io`, from wherever socketClientEntry found it. */
async function loadSocketClient(options) {
  const { io } = await import(socketClientEntry(options));

  return io;
}

export { loadSocketClient, socketClientEntry };
