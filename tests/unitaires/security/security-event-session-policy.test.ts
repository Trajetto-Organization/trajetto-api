import { describe, expect, it } from "vitest";

import { endsSession } from "@/shared/security/session-policy";

/**
 * The rule that decides whether a security event kills the socket. Getting it
 * wrong is silent: the UI simply stops reacting in realtime and only a page
 * reload reveals it, so the matrix is pinned here.
 */
describe("security event session policy", () => {
  it("keeps the session on an authorization-only change", () => {
    // The token is still valid; only what the user may do moved. The client
    // answers by re-reading /user/me, which needs the socket alive to hear
    // about the *next* change too.
    expect(endsSession("permissions_changed")).toBe(false);
    expect(endsSession("access_restored")).toBe(false);
  });

  it("ends the session when the identity itself stops being valid", () => {
    expect(endsSession("access_revoked")).toBe(true);
    expect(endsSession("access_denied")).toBe(true);
    expect(endsSession("driver_inactive")).toBe(true);
    expect(endsSession("session_compromised")).toBe(true);
    expect(endsSession("password_changed")).toBe(true);
    expect(endsSession("password_reset")).toBe(true);
    expect(endsSession("user_updated")).toBe(true);
    expect(endsSession("logout")).toBe(true);
  });

  it("defaults to ending the session for an unknown reason", () => {
    // A reason nobody listed must not accidentally inherit the permissive
    // branch — staying connected is the exception, not the default.
    expect(endsSession("something_new")).toBe(true);
  });
});
