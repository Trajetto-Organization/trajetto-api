import type { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import type { IDriverTrustedDeviceRepository } from "./IDriver-trusted-device-repository";
import { trustedSince } from "../services/trusted-devices";
import type {
  DriverTrustedDevice,
  TrustDriverDeviceProps,
} from "../dtos/driver-trusted-device-dto";

class DriverTrustedDeviceRepository implements IDriverTrustedDeviceRepository {
  constructor(private prisma = database) {}

  async trust(
    { userId, deviceHash, source, now = new Date() }: TrustDriverDeviceProps,
    tx?: Prisma.TransactionClient,
  ): Promise<{ created: boolean }> {
    const client = tx ?? this.prisma;

    // The unique pair decides "new for this login", even with two replicas
    // inserting at once: exactly one insert lands, the other is skipped.
    const { count } = await client.driverTrustedDevice.createMany({
      data: [
        {
          userId,
          device_hash: deviceHash,
          source,
          created_at: now,
          last_login_at: now,
        },
      ],
      skipDuplicates: true,
    });

    if (count === 1) return { created: true };

    await client.driverTrustedDevice.updateMany({
      where: { userId, device_hash: deviceHash },
      data: { last_login_at: now },
    });

    return { created: false };
  }

  async trustingLogins(
    userIds: string[],
    deviceHash: string,
    now = new Date(),
  ): Promise<string[]> {
    // Served by the unique (userId, device_hash).
    const rows = await this.prisma.driverTrustedDevice.findMany({
      where: {
        userId: { in: userIds },
        device_hash: deviceHash,
        last_login_at: { gte: trustedSince(now) },
      },
      select: { userId: true },
    });

    return rows.map((row) => row.userId);
  }

  async recordLogin(
    userId: string,
    deviceHash: string,
    now = new Date(),
  ): Promise<void> {
    await this.prisma.driverTrustedDevice.updateMany({
      where: { userId, device_hash: deviceHash },
      data: { last_login_at: now },
    });
  }

  async listForUser(userId: string): Promise<DriverTrustedDevice[]> {
    const rows = await this.prisma.driverTrustedDevice.findMany({
      where: { userId },
      orderBy: [{ last_login_at: "desc" }, { id: "asc" }],
    });

    return rows as DriverTrustedDevice[];
  }

  async revoke(userId: string, deviceHash: string): Promise<number> {
    const { count } = await this.prisma.driverTrustedDevice.deleteMany({
      where: { userId, device_hash: deviceHash },
    });

    return count;
  }

  async revokeAllForUser(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await (tx ?? this.prisma).driverTrustedDevice.deleteMany({
      where: { userId },
    });

    return count;
  }

  async deleteStale(now = new Date()): Promise<number> {
    // A daily sweep of a table of a few rows per driver login.
    const { count } = await this.prisma.driverTrustedDevice.deleteMany({
      where: { last_login_at: { lt: trustedSince(now) } },
    });

    return count;
  }
}

export { DriverTrustedDeviceRepository };
