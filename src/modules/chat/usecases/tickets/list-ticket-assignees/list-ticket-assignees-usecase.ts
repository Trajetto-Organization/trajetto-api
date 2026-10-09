import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { permissionDenied } from "@/shared/errors/access-errors";
import { compareCodePoints } from "@/shared/pagination/in-memory-order";

import { resolveTicketScope } from "../ticket-access";

/** A company's operators are a short list; this bounds the answer anyway. */
const ASSIGNEES_LIMIT = 100;

/**
 * Who can take a ticket (design §4.7): the company's delivery operators
 * (BUSINESS_ADMIN or a profile that writes delivery_manage, not a driver,
 * not revoked) — the same list the occurrence notices go to. Only id and
 * name: it is a picker.
 */
@injectable()
class ListTicketAssigneesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute(request: {
    userId: string;
    businessId?: string;
    search?: string;
  }): Promise<{ data: Array<{ id: string; name: string }> }> {
    const scope = await resolveTicketScope(this.user, request.userId, request.businessId);

    if (scope.driverId) {
      throw permissionDenied("Motoristas não possuem permissão para acessar este recurso.");
    }

    const search = request.search?.trim().toLowerCase() ?? "";
    const operators = await this.user.findDeliveryOperators(scope.businessId);

    return {
      data: operators
        .filter((operator) => !search || operator.name.toLowerCase().includes(search))
        .map((operator) => ({ id: operator.id, name: operator.name }))
        .sort((a, b) => compareCodePoints(a.name, b.name) || compareCodePoints(a.id, b.id))
        .slice(0, ASSIGNEES_LIMIT),
    };
  }
}

export { ListTicketAssigneesUseCase };
