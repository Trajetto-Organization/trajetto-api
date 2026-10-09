import { inject, injectable } from "tsyringe";
import { BusinessModule } from "@prisma/client";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { User } from "../../dtos/user-dto";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UploadService } from "@/shared/services/upload-service";
import { aiProviderConfigured } from "@/shared/ai/ai-provider";
import { getQuotaUsage } from "@/shared/ai/ai-quota-service";
import {
  sessionPrecheckFlag,
  type SessionPrecheckFlag,
} from "@/shared/ai-precheck/device-precheck";

@injectable()
class GetUserUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UploadService")
    private uploadService: UploadService,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(userId: string): Promise<User & { ai: SessionPrecheckFlag }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    return {
      ...findUser,
      enabledModules: resolveEnabledModules(findUser),
      ai: await this.sessionAi(findUser),
      avatar: findUser.avatar
        ? await this.uploadService.getFileUrl(findUser.avatar)
        : null,
    };
  }

  /**
   * Whether the app runs the offline pre-check (decision 14.2; §P5.1). Read
   * with the session so the app can cache it for its offline window. The
   * back office (MASTER) is no company and never runs it.
   */
  private async sessionAi(user: User): Promise<SessionPrecheckFlag> {
    if (user.role === "MASTER" || !user.businessId) {
      return { precheck: false, reason: "not_contracted" };
    }

    const business = await this.business.findBusinessById(user.businessId);
    const aiAnalysisLimit = business?.ai_analysis_limit ?? 0;
    const providerConfigured = aiProviderConfigured();

    // The period's ledger only when it can change the answer. A failure to
    // read it says nothing about the quota: the pre-check stays on, and the
    // server's own reservation is still the gate.
    const remaining =
      aiAnalysisLimit > 0 && providerConfigured
        ? await getQuotaUsage(user.businessId)
            .then((usage) => usage?.remaining ?? null)
            .catch(() => null)
        : null;

    return sessionPrecheckFlag({ aiAnalysisLimit, providerConfigured, remaining });
  }
}

/**
 * What this session may reach, module-wise. It travels with /me on purpose:
 * every user needs to know its own company's plan to draw a menu, while the
 * back-office endpoint that manages plans stays restricted to MASTER and
 * BUSINESS_ADMIN. Reading your own plan is not administering it.
 *
 * MASTER gets the whole enum — the back office operates across companies and
 * is never gated by what one of them hired.
 */
function resolveEnabledModules(user: User): string[] {
  if (user.role === "MASTER") {
    return Object.values(BusinessModule);
  }

  return (user.business?.entitlements ?? [])
    .filter((row) => row.enabled)
    .map((row) => row.module);
}

export { GetUserUseCase };
