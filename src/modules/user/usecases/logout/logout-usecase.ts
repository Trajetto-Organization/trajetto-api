import { inject, injectable } from "tsyringe";

import { sendSecurityEventToSession } from "@/websocket";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

@injectable()
class LogoutUseCase {
  constructor(
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute(sessionId: string): Promise<void> {
    // A normal logout is device/session scoped. Global invalidation remains
    // reserved for password changes, administrative revocation and replay.
    await this.usersTokens.revokeUserRefreshTokenFamily(sessionId);
    sendSecurityEventToSession(sessionId, { reason: "logout" });
  }
}

export { LogoutUseCase };
