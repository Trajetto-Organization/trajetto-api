import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { IOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/IOccurrence-type-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";

interface ListMyDeliveriesRequest {
  userId: string;
  businessId: string;
}

interface ListMyDeliveriesResult {
  deliveries: unknown[];
  occurrenceTypes: Array<{
    id: string;
    name: string;
    description: string | null;
    requires_photo: boolean;
    blocks_delivery: boolean;
  }>;
}

/**
 * The driver's working list, in one payload: own designated (PENDING with
 * driver) and IN_TRANSIT deliveries with shipper and cargo items, plus the
 * active occurrence types — everything the app's 7-day offline cache needs
 * in a single round trip.
 */
@injectable()
class ListMyDeliveriesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("OccurrenceTypeRepository")
    private occurrenceType: IOccurrenceTypeRepository,
  ) {}

  async execute({
    userId,
    businessId,
  }: ListMyDeliveriesRequest): Promise<ListMyDeliveriesResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (!findUser.driverId) {
      throw new AppError(
        "Esta rota é do aplicativo do motorista: apenas usuários vinculados a um motorista têm lista de entregas.",
        403,
        "DRIVER_ONLY",
      );
    }

    const [deliveries, occurrenceTypes] = await Promise.all([
      this.delivery.listDriverDeliveries(businessId, findUser.driverId),
      this.occurrenceType.listActiveOccurrenceTypes(businessId),
    ]);

    return { deliveries, occurrenceTypes };
  }
}

export { ListMyDeliveriesUseCase };
