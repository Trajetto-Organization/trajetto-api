import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

/** Removes expired refresh-token rows daily without touching active families. */
const cleanupExpiredRefreshTokensJob: CronJobDefinition = {
  name: "cleanup-expired-refresh-tokens",
  schedule: "17 3 * * *",

  async handler() {
    const deleted =
      await new UserTokensRepository().deleteExpiredUserRefreshTokens();
    console.log(
      `[RefreshTokenCleanup] ${deleted} token(s) expirado(s) removido(s)`,
    );
  },
};

export { cleanupExpiredRefreshTokensJob };
