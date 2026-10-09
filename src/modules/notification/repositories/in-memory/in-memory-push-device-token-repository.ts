import { v7 as uuidv7 } from "uuid";

import { Prisma } from "@prisma/client";

import type {
  IPushDeviceTokenRepository,
  RegisterPushDeviceData,
} from "../IPush-device-token-repository";

/** P2003, as Postgres answers a device pointing at a user that does not exist. */
function foreignKeyViolation(field: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Foreign key constraint violated on the constraint",
    { code: "P2003", clientVersion: "in-memory", meta: { field_name: field } },
  );
}

interface PushDeviceRow {
  id: string;
  token: string;
  platform: string;
  userId: string;
  session_family_id: string | null;
}

/**
 * Twin of PushDeviceTokenRepository (decision 13.2). `users`, when given,
 * plays the foreign key: Postgres refuses a device for a user that does not
 * exist with P2003, and so does the twin.
 */
class InMemoryPushDeviceTokenRepository implements IPushDeviceTokenRepository {
  public devices: PushDeviceRow[] = [];

  constructor(private users?: { has(userId: string): boolean }) {}

  async register({ token, platform, userId, sessionId }: RegisterPushDeviceData): Promise<void> {
    if (this.users && !this.users.has(userId)) {
      throw foreignKeyViolation("push_device_tokens_userId_fkey");
    }

    const existing = this.devices.find((device) => device.token === token);

    if (existing) {
      existing.platform = platform;
      existing.userId = userId;
      existing.session_family_id = sessionId;

      return;
    }

    this.devices.push({ id: uuidv7(), token, platform, userId, session_family_id: sessionId });
  }

  async removeForUser(token: string, userId: string): Promise<number> {
    const before = this.devices.length;

    this.devices = this.devices.filter(
      (device) => !(device.token === token && device.userId === userId),
    );

    return before - this.devices.length;
  }
}

export { InMemoryPushDeviceTokenRepository, type PushDeviceRow };
