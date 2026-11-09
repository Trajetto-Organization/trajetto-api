import type { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { hashSingleUseToken } from "@/shared/security/single-use-token";

import type { IDriverEnrollmentRepository } from "./IDriver-enrollment-repository";
import type {
  ConsumeDriverEnrollmentProps,
  DriverEnrollmentToken,
  IssueDriverEnrollmentProps,
} from "../dtos/driver-enrollment-dto";

class DriverEnrollmentRepository implements IDriverEnrollmentRepository {
  constructor(private prisma = database) {}

  async issue({
    userId,
    businessId,
    token,
    code,
    expiresAt,
    createdById,
  }: IssueDriverEnrollmentProps): Promise<DriverEnrollmentToken> {
    const secrets = {
      token_hash: hashSingleUseToken(token),
      code_hash: code === null ? null : hashSingleUseToken(code),
      expires_at: expiresAt,
      createdById,
    };

    // A code colliding with another live one fails on the unique index
    // (P2002 on code_hash): the caller draws a new code and issues again.
    return this.prisma.driverEnrollmentToken.upsert({
      where: { userId },
      create: { userId, businessId, ...secrets },
      update: {
        ...secrets,
        consumed_at: null,
        device_id: null,
        attempts: 0,
        // The row's created_at is the issue of THIS code: its age is what
        // the screen counts down from.
        created_at: new Date(),
      },
    });
  }

  async findByToken(token: string): Promise<DriverEnrollmentToken | null> {
    return this.prisma.driverEnrollmentToken.findUnique({
      where: { token_hash: hashSingleUseToken(token) },
    });
  }

  async findByCode(code: string): Promise<DriverEnrollmentToken | null> {
    return this.prisma.driverEnrollmentToken.findUnique({
      where: { code_hash: hashSingleUseToken(code) },
    });
  }

  async findByUserId(userId: string): Promise<DriverEnrollmentToken | null> {
    return this.prisma.driverEnrollmentToken.findUnique({ where: { userId } });
  }

  async consume(
    id: string,
    {
      tokenHash,
      deviceId,
      now = new Date(),
      maxAttempts,
    }: ConsumeDriverEnrollmentProps,
  ): Promise<boolean> {
    // The conditional update is the lock: of two phones presenting the same
    // QR at once, exactly one sees it live. The hash pins the code that was
    // read: a regeneration in between kept the id and changed the code.
    const { count } = await this.prisma.driverEnrollmentToken.updateMany({
      where: {
        id,
        token_hash: tokenHash,
        consumed_at: null,
        expires_at: { gt: now },
        attempts: { lt: maxAttempts },
      },
      data: { consumed_at: now, device_id: deviceId },
    });

    return count === 1;
  }

  async recordFailedAttempt(id: string, tokenHash: string): Promise<number> {
    const rows = await this.prisma.driverEnrollmentToken.updateManyAndReturn({
      where: { id, token_hash: tokenHash },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });

    return rows[0]?.attempts ?? 0;
  }

  async revokeForUser(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await (
      tx ?? this.prisma
    ).driverEnrollmentToken.deleteMany({ where: { userId } });

    return count;
  }

  async forgetDevice(userId: string, deviceId: string): Promise<number> {
    const { count } = await this.prisma.driverEnrollmentToken.updateMany({
      where: { userId, device_id: deviceId },
      data: { device_id: null },
    });

    return count;
  }
}

export { DriverEnrollmentRepository };
