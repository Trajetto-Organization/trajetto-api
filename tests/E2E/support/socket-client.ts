/**
 * Where the socket E2E tests borrow `socket.io-client` from.
 *
 * The client lives in the web repository: the API is a server and has none,
 * and a test-only dependency in the production package is a dependency
 * somebody eventually imports in production.
 *
 * One resolver for the E2E tests and the load scripts (TST-1): both used to
 * carry their own copy, and the load copy kept the web repository's old name
 * after the E2E one was fixed. It tries `trajetto-ui` and the old
 * `trajetto-fleet-manager-ui` next to this repository, and
 * `SOCKET_IO_CLIENT_ENTRY` overrides both.
 */
export { socketClientEntry } from "../../load/lib/socket-client.mjs";
