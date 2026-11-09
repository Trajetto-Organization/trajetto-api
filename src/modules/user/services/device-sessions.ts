import type { UserDeviceSession } from "../dtos/user-tokens-dto";
import { hashDeviceId } from "./session-service";

interface LiveDeviceRow {
  device_id: string | null;
  family_id: string;
  created_at: Date;
  expires_in: Date;
}

/**
 * The live refresh-token rows of a user, as the manager's phone list (plan of
 * 02/11/2026, D7): one entry per phone, counting its sessions (a family may
 * have two live rows for a moment, after a raced renewal), the latest renewal
 * as its last activity, and the latest expiry. Most recent first; the phone's
 * hash breaks ties, so the order is the same in both repositories.
 *
 * The phone leaves as its hash, never its id (wave 2): the CPF login checks
 * the phone by that id, and whoever reads the list — a profile that may only
 * read users included — would hold every driver's second factor.
 */
function groupDeviceSessions(rows: LiveDeviceRow[]): UserDeviceSession[] {
  const byDevice = new Map<
    string,
    { families: Set<string>; last: Date; expires: Date }
  >();

  for (const row of rows) {
    if (!row.device_id) continue;

    const deviceHash = hashDeviceId(row.device_id);
    const entry = byDevice.get(deviceHash);

    if (!entry) {
      byDevice.set(deviceHash, {
        families: new Set([row.family_id]),
        last: row.created_at,
        expires: row.expires_in,
      });

      continue;
    }

    entry.families.add(row.family_id);
    if (row.created_at > entry.last) entry.last = row.created_at;
    if (row.expires_in > entry.expires) entry.expires = row.expires_in;
  }

  return [...byDevice.entries()]
    .map(([device_hash, entry]) => ({
      device_hash,
      sessions: entry.families.size,
      last_activity_at: entry.last,
      expires_at: entry.expires,
    }))
    .sort(
      (left, right) =>
        right.last_activity_at.getTime() - left.last_activity_at.getTime() ||
        left.device_hash.localeCompare(right.device_hash),
    );
}

export { groupDeviceSessions };
