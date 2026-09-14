import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import { DeliveryStatus } from "@/shared/delivery/delivery-rules";

import { ListDeliveriesResult } from "../../dtos/delivery-dto";

interface ListDeliveriesRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  status?: DeliveryStatus;
  shipperId?: string;
  driverId?: string;
  search?: string;
}

@injectable()
class ListDeliveryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    status,
    shipperId,
    driverId,
    search,
  }: ListDeliveriesRequest): Promise<ListDeliveriesResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // MASTER picks the company explicitly; everyone else is pinned to
    // their own — same resolution every list route in the app uses.
    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    // Drivers only see their own route — the app never lists the whole
    // operation to the person executing one slice of it.
    const effectiveDriverId = findUser.driverId ?? driverId;

    try {
      // The status breakdown ignores the current filters on purpose: the
      // cards describe the operation, not the slice being looked at.
      const [result, statusCounts] = await Promise.all([
        this.delivery.listDeliveries({
          page,
          pageSize,
          businessId: resolvedBusinessId,
          status,
          shipperId,
          driverId: effectiveDriverId,
          search,
        }),
        this.delivery.countDeliveriesByStatus(
          resolvedBusinessId,
          effectiveDriverId,
        ),
      ]);

      return { ...result, meta: { statusCounts } };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Não foi possível recuperar as entregas!", 500);
    }
  }
}

export { ListDeliveryUseCase };
