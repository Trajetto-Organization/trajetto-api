/**
 * Whether a security event ends the session or only changes what it may do.
 * Pure and apart from the socket layer so it can be reasoned about — and
 * tested — without a server.
 */

/**
 * Events that change a session's *authorization* while leaving its
 * *authentication* intact. The socket survives them: the client re-reads
 * /user/me and redraws its menus, buttons and shortcuts.
 *
 * The distinction is not cosmetic. A server-side disconnect is final —
 * socket.io-client does not reconnect from "io server disconnect" — so
 * dropping the socket on a permission edit left the whole company without
 * realtime until the next full page load: the first change still arrived
 * (the emit precedes the disconnect), every one after it was lost.
 */
const AUTHORIZATION_ONLY_REASONS = new Set<string>([
  "access_restored",
  "permissions_changed",
]);

/**
 * Default-deny on purpose: a reason nobody listed keeps the old, safe
 * behaviour of ending the session.
 */
function endsSession(reason: string): boolean {
  return !AUTHORIZATION_ONLY_REASONS.has(reason);
}

export { endsSession, AUTHORIZATION_ONLY_REASONS };
