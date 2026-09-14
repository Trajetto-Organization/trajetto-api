import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import {
  ShipperNotFoundError,
  ShipperNotBelongBusinessError,
} from "@/modules/shipper/usecases/errors/shipper-errors";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DeliveryVehicleUnavailableError } from "../errors/delivery-errors";
import { isVehicleOutOfOperation } from "@/shared/vehicle/vehicle-rules";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { DeliveryInvoiceKeyExistsError } from "../errors/delivery-errors";
import { AppError } from "@/shared/errors/AppError";

import { Delivery, CreateDeliveryProps } from "../../dtos/delivery-dto";

@injectable()
class CreateDeliveryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    deliveryData: CreateDeliveryProps,
    userId: string,
  ): Promise<Delivery> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Dispatcher-only: the driver permission table opens delivery_manage so
    // the app's own routes work, which would otherwise open management too.
    // Creating, editing, importing and assigning belong to the dispatcher.
    if (findUser.driverId) {
      throw new AppError(
        "Motoristas não gerenciam entregas: criação, edição e atribuição são do despachante.",
        403,
        "DRIVER_CANNOT_MANAGE_DELIVERIES",
      );
    }

    const findBusiness = await this.business.findBusinessById(
      deliveryData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findShipper = await this.shipper.findShipperById(
      deliveryData.shipperId,
    );

    if (!findShipper) {
      throw new ShipperNotFoundError();
    }

    if (findShipper.businessId !== deliveryData.businessId) {
      throw new ShipperNotBelongBusinessError();
    }

    if (findShipper.is_active === false) {
      throw new AppError(
        "Este embarcador está inativo. Reative-o para registrar novas entregas.",
        400,
      );
    }

    // The same NFe never spawns two deliveries (manual or imported).
    if (deliveryData.invoice_key) {
      const existing = await this.delivery.findDeliveryByInvoiceKey(
        deliveryData.businessId,
        deliveryData.invoice_key,
      );

      if (existing) {
        throw new DeliveryInvoiceKeyExistsError();
      }
    }

    if (deliveryData.vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(
        deliveryData.vehicleId,
      );

      if (!findVehicle) {
        throw new VehicleNotFoundError();
      }

      if (findVehicle.businessId !== deliveryData.businessId) {
        throw new VehicleNotBelongBusinessError();
      }

      // Same refusal assign-deliveries already makes. Without it there were
      // two doors onto the same delivery and only one of them was guarded:
      // a vehicle out of operation could not be ASSIGNED to a load but could
      // be attached to it at creation.
      if (isVehicleOutOfOperation(findVehicle.status)) {
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

      if (findDriver.businessId !== deliveryData.businessId) {
        throw new DriverNotBelongBusinessError();
      }
    }

    try {
      const deliveryCreated = await this.delivery.createDelivery(deliveryData);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "create",
        entityId: deliveryCreated.id as string,
        description: `Entrega para ${deliveryCreated.recipient_name} criada | ID: ${deliveryCreated.id}`,
        status: "Pendente",
        performedBy: userId,
        businessId: deliveryData.businessId,
      });

      return deliveryCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar a entrega! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateDeliveryUseCase };
