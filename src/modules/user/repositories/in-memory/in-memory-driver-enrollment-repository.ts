import { v7 as uuidV7 } from "uuid";

import { hashSingleUseToken } from "@/shared/security/single-use-token";
import { uniqueViolation } from "@/shared/in-memory/prisma-errors";

import type { IDriverEnrollmentRepository } from "../IDriver-enrollment-repository";
import type {
  ConsumeDriverEnrollmentProps,
  DriverEnrollmentToken,
  IssueDriverEnrollmentProps,
} from "../../dtos/driver-enrollment-dto";

/**
 * The twin of DriverEnrollmentRepository, with the same semantics: one row
 * per user (upsert), hashes only, the unique token and code (a null code
 * never collides), and a single-winner consumption.
 */
class InMemoryDriverEnrollmentRepository implements IDriverEnrollmentRepository {
  public tokens: DriverEnrollmentToken[] = [];

  async issue({
    userId,
    businessId,
    token,
    code,
    expiresAt,
    createdById,
  }: IssueDriverEnrollmentProps): Promise<DriverEnrollmentToken> {
    const tokenHash = hashSingleUseToken(token);
    const codeHash = code === null ? null : hashSingleUseToken(code);
    const others = this.tokens.filter((row) => row.userId !== userId);

    if (others.some((row) => row.token_hash === tokenHash)) {
      throw uniqueViolation(["token_hash"]);
    }

    if (codeHash !== null && others.some((row) => row.code_hash === codeHash)) {
      throw uniqueViolation(["code_hash"]);
    }

    const existing = this.tokens.find((row) => row.userId === userId);
    const row: DriverEnrollmentToken = {
      id: existing?.id ?? uuidV7(),
      userId,
      businessId: existing?.businessId ?? businessId,
      token_hash: tokenHash,
      code_hash: codeHash,
      expires_at: expiresAt,
      consumed_at: null,
      createdById,
      device_id: null,
      attempts: 0,
      created_at: new Date(),
    };

    this.tokens = [...others, row];

    return { ...row };
  }

  async findByToken(token: string): Promise<DriverEnrollmentToken | null> {
    const hash = hashSingleUseToken(token);
    const row = this.tokens.find((entry) => entry.token_hash === hash);

    return row ? { ...row } : null;
  }

  async findByCode(code: string): Promise<DriverEnrollmentToken | null> {
    const hash = hashSingleUseToken(code);
    const row = this.tokens.find((entry) => entry.code_hash === hash);

    return row ? { ...row } : null;
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
    const row = this.tokens.find((entry) => entry.id === id);

    if (
      !row ||
      row.token_hash !== tokenHash ||
      row.consumed_at !== null ||
      row.expires_at.getTime() <= now.getTime() ||
      row.attempts >= maxAttempts
    ) {
      return false;
    }

    row.consumed_at = now;
    row.device_id = deviceId;

    return true;
  }

  async recordFailedAttempt(id: string, tokenHash: string): Promise<number> {
    const row = this.tokens.find((entry) => entry.id === id);

    if (!row || row.token_hash !== tokenHash) return 0;

    row.attempts += 1;

    return row.attempts;
  }

  async revokeForUser(userId: string): Promise<number> {
    const before = this.tokens.length;

    this.tokens = this.tokens.filter((row) => row.userId !== userId);

    return before - this.tokens.length;
  }
}

export { InMemoryDriverEnrollmentRepository };
