import type { IOpsAlertPreferenceRepository } from "../IOps-alert-preference-repository";

/** Twin of the user column: absent user = null, default true (the column's). */
class InMemoryOpsAlertPreferenceRepository
  implements IOpsAlertPreferenceRepository
{
  public users = new Map<string, { ops_alert_sound_enabled?: boolean }>();

  async getSound(userId: string): Promise<boolean | null> {
    const user = this.users.get(userId);

    return user ? (user.ops_alert_sound_enabled ?? true) : null;
  }

  async setSound(userId: string, enabled: boolean): Promise<void> {
    const user = this.users.get(userId);

    if (user) user.ops_alert_sound_enabled = enabled;
  }
}

export { InMemoryOpsAlertPreferenceRepository };
