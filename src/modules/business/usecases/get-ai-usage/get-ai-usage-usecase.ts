import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { assertCallerRole } from "@/modules/business/usecases/errors/business-role-guard";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import {
  getQuotaUsage,
  getQuotaUsageByType,
} from "@/shared/ai/ai-quota-service";

interface GetAIUsageRequest {
  userId: string;
  businessId: string;
}

@injectable()
class GetAIUsageUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({ userId, businessId }: GetAIUsageRequest) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // The route's answers (403 AUTH_ROLE_FORBIDDEN, then 403
    // TENANT_ACCESS_DENIED), repeated here: the old check only looked at
    // BUSINESS_ADMIN, so any other non-master role read any company's usage.
    assertCallerRole(findUser, ["MASTER", "BUSINESS_ADMIN"]);
    assertTenantAccess(findUser, businessId);

    const business = await this.business.findAIUsage(businessId);

    if (!business) {
      throw new BusinessNotFoundError();
    }

    // Consumption comes from the AIUsagePeriod ledger, over the company's
    // civil month (AI-15). The response keeps the legacy field names the
    // frontends already render; "reset_at" is when this month's counting
    // began and "next_reset_at" when the next one begins, both instants of
    // midnight in the company's zone (the date-only key read as a date showed
    // "31/08 21:00" in Brasília). "used" counts only finished provider calls
    // — one per photo — and analyses still running ride in "in_progress".
    const usage = await getQuotaUsage(businessId);

    const byType = usage
      ? await getQuotaUsageByType(usage.periodId, usage.startsAt)
      : { fuel: 0, checklist: 0, proof: 0 };

    return {
      ...business,
      ai_analysis_used: usage?.consumed ?? 0,
      ai_analysis_in_progress: usage?.inProgress ?? 0,
      // ISO strings, not Dates: the response schema serializes what it gets,
      // and a Date went out as "Thu Oct 01 2026 04:00:00 GMT+0000 (...)".
      ai_analysis_reset_at: usage?.startsAt.toISOString() ?? null,
      ai_analysis_next_reset_at: usage?.resetAt.toISOString() ?? null,
      ai_analysis_timezone: usage?.timeZone ?? null,
      ai_analysis_remaining: usage?.remaining ?? business.ai_analysis_limit,
      ai_analysis_enabled: business.ai_analysis_limit > 0,
      ai_analysis_used_by_type: byType,
    };
  }
}

export { GetAIUsageUseCase };
