import { v7 as uuidV7 } from "uuid";

import type { IDriverTrustedDeviceRepository } from "../IDriver-trusted-device-repository";
import { trustedSince } from "../../services/trusted-devices";
import type {
  DriverTrustedDevice,
  TrustDriverDeviceProps,
} from "../../dtos/driver-trusted-device-dto";

/**
 * The twin of DriverTrustedDeviceRepository, with the same semantics: one row
 * per (login, phone hash), a repeat only moves `last_login_at`, and the
 * listing is the most recently used first.
 */
class InMemoryDriverTrustedDeviceRepository implements IDriverTrustedDeviceRepository {
  public devices: DriverTrustedDevice[] = [];

  async trust({
    userId,
    deviceHash,
    source,
    now = new Date(),
  }: TrustDriverDeviceProps): Promise<{ created: boolean }> {
    const existing = this.devices.find(
      (row) => row.userId === userId && row.device_hash === deviceHash,
    );

    if (existing) {
      existing.last_login_at = now;

      return { created: false };
    }

    this.devices.push({
      id: uuidV7(),
      userId,
      device_hash: deviceHash,
      source,
      created_at: now,
      last_login_at: now,
    });

    return { created: true };
  }

  async trustingLogins(
    userIds: string[],
    deviceHash: string,
    now = new Date(),
  ): Promise<string[]> {
    const since = trustedSince(now);

    return this.devices
      .filter(
        (row) =>
          userIds.includes(row.userId) &&
          row.device_hash === deviceHash &&
          row.last_login_at >= since,
      )
      .map((row) => row.userId);
  }

  async recordLogin(
    userId: string,
    deviceHash: string,
    now = new Date(),
  ): Promise<void> {
    for (const row of this.devices) {
      if (row.userId === userId && row.device_hash === deviceHash) {
        row.last_login_at = now;
      }
    }
  }

  async listForUser(userId: string): Promise<DriverTrustedDevice[]> {
    return this.devices
      .filter((row) => row.userId === userId)
      .sort(
        (left, right) =>
          right.last_login_at.getTime() - left.last_login_at.getTime() ||
          left.id.localeCompare(right.id),
      )
      .map((row) => ({ ...row }));
  }

  async revoke(userId: string, deviceHash: string): Promise<number> {
    const before = this.devices.length;

    this.devices = this.devices.filter(
      (row) => !(row.userId === userId && row.device_hash === deviceHash),
    );

    return before - this.devices.length;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const before = this.devices.length;

    this.devices = this.devices.filter((row) => row.userId !== userId);

    return before - this.devices.length;
  }

  async deleteStale(now = new Date()): Promise<number> {
    const since = trustedSince(now);
    const before = this.devices.length;

    this.devices = this.devices.filter((row) => row.last_login_at >= since);

    return before - this.devices.length;
  }
}

export { InMemoryDriverTrustedDeviceRepository };
