import auth from "@/config/auth";

import type {
  UserOwnSession,
  UserSessionFamily,
} from "../dtos/user-tokens-dto";
import { familyStartedAtOf } from "./session-service";

interface LiveSessionRow {
  family_id: string;
  device_id: string | null;
  created_at: Date;
  expires_in: Date;
}

const WEB_IDLE_MS = auth.refresh_policies.web.idleSeconds * 1000;

/**
 * Which client holds a session, from what the rows store (wave 2, "Aparelhos
 * conectados").
 *
 * The policy the login chose rides in the refresh token's signed claim, not
 * in the row, so it is read back from its traces. A phone id means the
 * phone-bound session (only the QR code and the CPF login set it). Otherwise
 * the mobile policy is the only one that idles longer than the web's day,
 * which the latest row's lifetime shows — except in the last day of its
 * 30-day cap, where a push device the session registered (only the app
 * registers one) still tells it apart.
 */
function sessionKind(
  deviceBound: boolean,
  lastActivityAt: Date,
  expiresAt: Date,
  registeredPush: boolean,
): UserOwnSession["kind"] {
  if (deviceBound) return "aparelho";
  if (expiresAt.getTime() - lastActivityAt.getTime() > WEB_IDLE_MS) {
    return "app";
  }

  return registeredPush ? "app" : "navegador";
}

/**
 * The live refresh-token rows of a user, one entry per session (family): a
 * family may hold two live rows for a moment after a raced renewal. The
 * session began at its login — read from the family id (familyStartedAtOf),
 * or its oldest live row for an id of another kind — was last used at its
 * latest renewal and lapses with its latest expiry. Most recent activity
 * first; the family id breaks ties, so both repositories agree.
 */
function groupOwnSessions(
  rows: LiveSessionRow[],
  pushFamilies: ReadonlySet<string>,
): UserOwnSession[] {
  const byFamily = new Map<
    string,
    { deviceBound: boolean; first: Date; last: Date; expires: Date }
  >();

  for (const row of rows) {
    const entry = byFamily.get(row.family_id);

    if (!entry) {
      byFamily.set(row.family_id, {
        deviceBound: row.device_id !== null,
        first: row.created_at,
        last: row.created_at,
        expires: row.expires_in,
      });

      continue;
    }

    if (row.device_id !== null) entry.deviceBound = true;
    if (row.created_at < entry.first) entry.first = row.created_at;
    if (row.created_at > entry.last) {
      entry.last = row.created_at;
      entry.expires = row.expires_in;
    } else if (row.created_at.getTime() === entry.last.getTime()) {
      if (row.expires_in > entry.expires) entry.expires = row.expires_in;
    }
  }

  return [...byFamily.entries()]
    .map(([familyId, entry]): UserOwnSession => {
      const bornAt = familyStartedAtOf(familyId);

      return {
        family_id: familyId,
        kind: sessionKind(
          entry.deviceBound,
          entry.last,
          entry.expires,
          pushFamilies.has(familyId),
        ),
        created_at: bornAt === null ? entry.first : new Date(bornAt * 1000),
        last_activity_at: entry.last,
        expires_at: entry.expires,
      };
    })
    .sort(
      (left, right) =>
        right.last_activity_at.getTime() - left.last_activity_at.getTime() ||
        left.family_id.localeCompare(right.family_id),
    );
}

/**
 * The session a request runs in, from every row of its family: null unless
 * one row is still live (neither revoked nor expired) — a session that ended
 * is not re-issued. The phone it is bound to rides on its rows (every
 * rotation carries it); its first row is the oldest still stored.
 */
function sessionFamilyOf(
  familyId: string,
  rows: Array<{
    device_id: string | null;
    created_at: Date;
    revoked_at: Date | null;
    expires_in: Date;
  }>,
  now: Date,
): UserSessionFamily | null {
  const live = rows.some(
    (row) => row.revoked_at === null && row.expires_in > now,
  );

  if (!live) return null;

  return {
    family_id: familyId,
    device_id: rows.find((row) => row.device_id)?.device_id ?? null,
    first_issued_at: rows.reduce(
      (first, row) => (row.created_at < first ? row.created_at : first),
      rows[0].created_at,
    ),
  };
}

export { groupOwnSessions, sessionFamilyOf, sessionKind };
export type { LiveSessionRow };
