import { inject, injectable } from "tsyringe";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { CursorPaginatedServiceOrder } from "../../dtos/service-order-dto";
import { AppError } from "@/shared/errors/AppError";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";

interface SearchServiceOrderByVehicleCursorRequest {
  userId: string;
  vehicleId: string;
  limit?: number;
  cursor?: string;
}

@injectable()
class SearchServiceOrderByVehicleCursorUseCase {
  constructor(
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    vehicleId,
    limit = 10,
    cursor,
  }: SearchServiceOrderByVehicleCursorRequest): Promise<CursorPaginatedServiceOrder> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findVehicle = await this.vehicle.findVehicleById(vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    // Verify vehicle belongs to user's business
    if (findVehicle.businessId !== findUser.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    if (findUser.driverId && findVehicle.driverId !== findUser.driverId) {
      throw new VehicleNotAssignedToDriverError();
    }

    const findBusiness = await this.business.findBusinessById(
      findUser.businessId as string,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const result =
        await this.serviceOrder.searchServiceOrderByVehicleWithCursor({
          limit,
          cursor,
          vehicleId,
          businessId: findUser.businessId as string,
        });

      return result;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as ordens de serviço do veículo!",
        500,
      );
    }
  }
}

export { SearchServiceOrderByVehicleCursorUseCase };
