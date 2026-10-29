import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IShipperRepository } from "../../repositories/IShipper-repository";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import {
  ShipperNotFoundError,
  ShipperNameAlreadyExistsError,
  ShipperCnpjAlreadyExistsError,
} from "../errors/shipper-errors";

import { AppError } from "@/shared/errors/AppError";
import { Shipper, UpdateShipperProps } from "../../dtos/shipper-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import { sendCatalogChangedEvent } from "@/websocket";

interface UpdateShipperRequest {
  userId: string;
  businessId: string;
  shipperId: string;
  shipperData: UpdateShipperProps;
}

@injectable()
class UpdateShipperUseCase {
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
    shipperData,
  }: UpdateShipperRequest): Promise<Shipper> {
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

    if (shipperData.name && shipperData.name !== findShipper.name) {
      const findShipperByName = await this.shipper.findShipperByName(
        businessId,
        shipperData.name,
      );

      if (findShipperByName && findShipperByName.id !== shipperId) {
        throw new ShipperNameAlreadyExistsError();
      }
    }

    if (shipperData.cnpj && shipperData.cnpj !== findShipper.cnpj) {
      const findShipperByCnpj = await this.shipper.findShipperByCnpj(
        businessId,
        shipperData.cnpj,
      );

      if (findShipperByCnpj && findShipperByCnpj.id !== shipperId) {
        throw new ShipperCnpjAlreadyExistsError();
      }
    }

    let updated: Shipper;

    try {
      updated = await this.shipper.updateShipper(shipperId, shipperData);
    } catch (error) {
      if (violatesUniqueOn(error, "cnpj")) {
        throw new ShipperCnpjAlreadyExistsError();
      }

      if (violatesUniqueOn(error, "name")) {
        throw new ShipperNameAlreadyExistsError();
      }

      throw new AppError(
        "Houve um erro ao tentar atualizar o embarcador! Por favor, tente novamente.",
        500,
      );
    }

    // Deactivating hides it from every open "Novo cadastro" picker at once.
    sendCatalogChangedEvent(businessId, "shipper");

    return updated;
  }
}

export { UpdateShipperUseCase };
