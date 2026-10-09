import database from "@/../infra/database";

import type { IOpsAlertPreferenceRepository } from "./IOps-alert-preference-repository";

class OpsAlertPreferenceRepository implements IOpsAlertPreferenceRepository {
  constructor(private prisma = database) {}

  async getSound(userId: string): Promise<boolean | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ops_alert_sound_enabled: true },
    });

    return user ? user.ops_alert_sound_enabled : null;
  }

  async setSound(userId: string, enabled: boolean): Promise<void> {
    // updateMany: a user removed meanwhile is a no-op, not a P2025.
    await this.prisma.user.updateMany({
      where: { id: userId },
      data: { ops_alert_sound_enabled: enabled },
    });
  }
}

export { OpsAlertPreferenceRepository };
