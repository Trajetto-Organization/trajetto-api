interface RegisterPushDeviceData {
  token: string;
  platform: string;
  userId: string;

  /** The session (refresh-token family) that registered the device. */
  sessionId: string;
}

/**
 * The Expo push tokens of the devices people are signed in on.
 *
 * A token is unique per DEVICE, not per user: registering a token another
 * account holds moves it to the new owner, so pushes follow whoever is
 * signed in on that phone now.
 */
interface IPushDeviceTokenRepository {
  /** Creates the device row, or reassigns the existing token to this login. */
  register: (data: RegisterPushDeviceData) => Promise<void>;

  /**
   * Deletes the token only when it belongs to `userId`; one user cannot
   * unregister another's device. Returns how many rows went (0 or 1).
   */
  removeForUser: (token: string, userId: string) => Promise<number>;
}

export type { IPushDeviceTokenRepository, RegisterPushDeviceData };
