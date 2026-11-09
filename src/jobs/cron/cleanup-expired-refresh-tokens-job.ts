import { DriverTrustedDeviceRepository } from "@/modules/user/repositories/driver-trusted-device-repository";
import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

const log = logger.child({
  component: "cron",
  job: "cleanup-expired-refresh-tokens",
});

/**
 * Removes expired refresh-token rows daily without touching active families,
 * then the push devices of the sessions that just disappeared with them, and
 * the phones no longer trusted for the CPF login (wave 2: no sign-in on them
 * for longer than the longest phone-bound session and its idle window).
 */
const cleanupExpiredRefreshTokensJob: CronJobDefinition = {
  name: "cleanup-expired-refresh-tokens",
  schedule: "17 3 * * *",

  async handler() {
    const tokens = new UserTokensRepository();

    const deleted = await tokens.deleteExpiredUserRefreshTokens();
    log.info({ deleted }, "expired refresh tokens removed");

    // After the purge, on purpose: a session whose last token expired is now
    // gone, and a device it registered would otherwise keep receiving this
    // user's pushes — a logout the server never heard (offline, app killed).
    const devices = await tokens.deleteOrphanPushTokens();
    log.info({ deleted: devices }, "push devices of ended sessions removed");

    // The CPF login already ignores them; this only keeps the table to the
    // phones that still count.
    const phones = await new DriverTrustedDeviceRepository().deleteStale();
    log.info({ deleted: phones }, "stale trusted driver phones removed");
  },
};

export { cleanupExpiredRefreshTokensJob };
