import auth from "@/config/auth";

const PHONE_POLICY = auth.refresh_policies.driver_device;

/**
 * How long a phone stays trusted for the CPF login with no sign-in on it
 * (wave 2): the longest phone-bound session plus its idle window.
 *
 * A session renews without signing in again, so the trust must outlive the
 * 180-day cap — the driver signs in once more when it ends, and that moves
 * `last_login_at`. Without a limit, a phone left in a drawer after a logout
 * stayed trusted forever, and the manager could not even see it: the phones
 * list shows live sessions only.
 */
const TRUSTED_DEVICE_IDLE_MS =
  (PHONE_POLICY.maxAgeSeconds + PHONE_POLICY.idleSeconds) * 1000;

/** The oldest last sign-in that still trusts a phone at `now`. */
function trustedSince(now: Date): Date {
  return new Date(now.getTime() - TRUSTED_DEVICE_IDLE_MS);
}

export { TRUSTED_DEVICE_IDLE_MS, trustedSince };
