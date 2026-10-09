import database from "@/../infra/database";

import type {
  IPushDeviceTokenRepository,
  RegisterPushDeviceData,
} from "./IPush-device-token-repository";

class PushDeviceTokenRepository implements IPushDeviceTokenRepository {
  constructor(private prisma = database) {}

  async register({ token, platform, userId, sessionId }: RegisterPushDeviceData): Promise<void> {
    // An upsert on the unique token, not find-then-create: the app registers
    // on every launch, and two launches racing must not raise P2002.
    await this.prisma.pushDeviceToken.upsert({
      where: { token },
      create: { token, platform, userId, session_family_id: sessionId },
      update: { platform, userId, session_family_id: sessionId },
    });
  }

  async removeForUser(token: string, userId: string): Promise<number> {
    const { count } = await this.prisma.pushDeviceToken.deleteMany({
      where: { token, userId },
    });

    return count;
  }
}

export { PushDeviceTokenRepository };
