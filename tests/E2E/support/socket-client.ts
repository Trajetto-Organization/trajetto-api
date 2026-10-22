/**
 * Where the socket E2E tests get `socket.io-client`.
 *
 * The API's own devDependency first (pinned to the web's version, so the
 * suite runs on this repository alone, as in CI), then the web repository
 * next to this one; `SOCKET_IO_CLIENT_ENTRY` overrides both.
 *
 * One resolver for the E2E tests and the load scripts (TST-1): both used to
 * carry their own copy, and the load copy kept the web repository's old name
 * after the E2E one was fixed.
 */
export { socketClientEntry } from "../../load/lib/socket-client.mjs";
