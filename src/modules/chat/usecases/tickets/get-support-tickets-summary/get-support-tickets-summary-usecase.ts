import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { ISupportTicketRepository } from "../../../repositories/ISupport-ticket-repository";
import type { SupportTicketCounts } from "../../../dtos/support-ticket-dto";

import { permissionDenied } from "@/shared/errors/access-errors";
import { resolveTicketScope } from "../ticket-access";

/**
 * The counts behind the floating balloon and the tab badge (design §4.3).
 * Cheap on purpose (partial indexes): every socket event refetches it, and it
 * is the truth after a reconnection — the socket is only the hint.
 */
@injectable()
class GetSupportTicketsSummaryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SupportTicketRepository")
    private tickets: ISupportTicketRepository,
  ) {}

  async execute({
    userId,
    businessId,
  }: {
    userId: string;
    businessId?: string;
  }): Promise<SupportTicketCounts> {
    const scope = await resolveTicketScope(this.user, userId, businessId);

    // The route refuses driver tokens too; restated for any other caller.
    if (scope.driverId) {
      throw permissionDenied("Motoristas não possuem permissão para acessar este recurso.");
    }

    return this.tickets.counts({
      businessId: scope.businessId,
      requesterUserId: scope.user.id,
    });
  }
}

export { GetSupportTicketsSummaryUseCase };
