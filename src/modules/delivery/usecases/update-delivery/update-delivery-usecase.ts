import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
  DeliveryNotEditableError,
  DeliveryVehicleUnavailableError,
} from "../errors/delivery-errors";

import {
  ShipperNotFoundError,
  ShipperNotBelongBusinessError,
} from "@/modules/shipper/usecases/errors/shipper-errors";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { isVehicleOutOfOperation } from "@/shared/vehicle/vehicle-rules";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { AppError } from "@/shared/errors/AppError";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { Delivery, UpdateDeliveryProps } from "../../dtos/delivery-dto";

interface UpdateDeliveryRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  deliveryData: UpdateDeliveryProps;
}

@injectable()
class UpdateDeliveryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    deliveryData,
  }: UpdateDeliveryRequest): Promise<Delivery> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // One definition, shared: see assertDispatcher.
    assertDispatcher(findUser);

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    if (!findDelivery) {
      throw new DeliveryNotFoundError();
    }

    if (findDelivery.businessId !== businessId) {
      throw new DeliveryNotBelongBusinessError();
    }

    // Editing is limited to statuses where the cargo is not moving and the
    // outcome is not proven: pending and failed (awaiting redelivery).
    if (findDelivery.status !== "PENDING" && findDelivery.status !== "FAILED") {
      throw new DeliveryNotEditableError();
    }

    if (
      deliveryData.shipperId &&
      deliveryData.shipperId !== findDelivery.shipperId
    ) {
      const findShipper = await this.shipper.findShipperById(
        deliveryData.shipperId,
      );

      if (!findShipper) {
        throw new ShipperNotFoundError();
      }

      if (findShipper.businessId !== businessId) {
        throw new ShipperNotBelongBusinessError();
      }
    }

    if (deliveryData.vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(
        deliveryData.vehicleId,
      );

      if (!findVehicle) {
        throw new VehicleNotFoundError();
      }

      if (findVehicle.businessId !== businessId) {
        throw new VehicleNotBelongBusinessError();
      }

      // Only when the vehicle is actually CHANGING — the same shape the
      // shipper check above uses. Refusing on every save would mean an
      // address typo could not be corrected on a load whose vehicle went out
      // of operation in the meantime, which is exactly when someone needs to
      // edit it.
      if (
        deliveryData.vehicleId !== findDelivery.vehicleId &&
        isVehicleOutOfOperation(findVehicle.status)
      ) {
        throw new DeliveryVehicleUnavailableError();
      }
    }

    if (deliveryData.driverId) {
      const findDriver = await this.driver.findDriverById(
        deliveryData.driverId,
      );

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== businessId) {
        throw new DriverNotBelongBusinessError();
      }
    }

    try {
      return await this.delivery.updateDelivery(deliveryId, deliveryData);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a entrega! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateDeliveryUseCase };
