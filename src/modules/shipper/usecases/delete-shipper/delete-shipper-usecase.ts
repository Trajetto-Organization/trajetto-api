import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IShipperRepository } from "../../repositories/IShipper-repository";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import {
  ShipperNotFoundError,
  ShipperHasDeliveriesError,
} from "../errors/shipper-errors";

import { AppError } from "@/shared/errors/AppError";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { sendCatalogChangedEvent } from "@/websocket";

interface DeleteShipperRequest {
  userId: string;
  businessId: string;
  shipperId: string;
}

@injectable()
class DeleteShipperUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
  ) {}

  async execute({
    userId,
    businessId,
    shipperId,
  }: DeleteShipperRequest): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // The operation's catalogue belongs to the dispatcher. `delivery_manage`
    // and `occurrence_manage` are open to the driver on purpose (the app runs
    // on them), so the permission table says yes and the use case says no.
    assertDispatcher(findUser);

    const findShipper = await this.shipper.findShipperById(shipperId);

    // Another company's id reads as absent (decision 11.3): a separate
    // "not yours" answer told a caller which ids exist elsewhere.
    if (!findShipper || findShipper.businessId !== businessId) {
      throw new ShipperNotFoundError();
    }

    // Deliveries carry the shipper's history — a shipper with deliveries is
    // deactivated, never deleted (same reasoning as vehicles: audit trail).
    const deliveryCount =
      await this.shipper.countDeliveriesByShipperId(shipperId);

    if (deliveryCount > 0) {
      throw new ShipperHasDeliveriesError(
        `Existem ${deliveryCount} entrega(s) vinculada(s) a ele.`,
      );
    }

    try {
      await this.shipper.deleteShipper(shipperId);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir o embarcador! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "shipper");
  }
}

export { DeleteShipperUseCase };
