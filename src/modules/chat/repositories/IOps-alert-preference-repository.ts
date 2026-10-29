/**
 * Decision 14.6: whether the web's operations alert plays a sound, per
 * person and server-side (it follows them across browsers and machines).
 * Stored in user.ops_alert_sound_enabled; the balloon itself always shows.
 */
interface IOpsAlertPreferenceRepository {
  /** Null when the user does not exist. */
  getSound: (userId: string) => Promise<boolean | null>;
  setSound: (userId: string, enabled: boolean) => Promise<void>;
}

export type { IOpsAlertPreferenceRepository };
