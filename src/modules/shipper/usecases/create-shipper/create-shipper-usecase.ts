import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IShipperRepository } from "../../repositories/IShipper-repository";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

import {
  ShipperNameAlreadyExistsError,
  ShipperCnpjAlreadyExistsError,
} from "../errors/shipper-errors";
import { AppError } from "@/shared/errors/AppError";

import { Shipper, CreateShipperProps } from "../../dtos/shipper-dto";

import {
  businessNotFound,
  callerNotFound,
} from "@/shared/delivery/caller-not-found";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import { sendCatalogChangedEvent } from "@/websocket";

@injectable()
class CreateShipperUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
  ) {}

  async execute(
    shipperData: CreateShipperProps,
    userId: string,
  ): Promise<Shipper> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // The operation's catalogue belongs to the dispatcher. `delivery_manage`
    // and `occurrence_manage` are open to the driver on purpose (the app runs
    // on them), so the permission table says yes and the use case says no.
    assertDispatcher(findUser);

    const findBusiness = await this.business.findBusinessById(
      shipperData.businessId,
    );

    if (!findBusiness) {
      throw businessNotFound();
    }

    const findShipperByName = await this.shipper.findShipperByName(
      shipperData.businessId,
      shipperData.name,
    );

    if (findShipperByName) {
      throw new ShipperNameAlreadyExistsError();
    }

    // One shipper per CNPJ in a company (decision 5.7): the NF-e import
    // matches the issuer by it, and two rows made the match arbitrary.
    if (shipperData.cnpj) {
      const findShipperByCnpj = await this.shipper.findShipperByCnpj(
        shipperData.businessId,
        shipperData.cnpj,
      );

      if (findShipperByCnpj) {
        throw new ShipperCnpjAlreadyExistsError();
      }
    }

    let created: Shipper;

    try {
      created = await this.shipper.createShipper(shipperData);
    } catch (error) {
      // A twin request committed between the checks and the insert: the
      // unique index decided, and the answer is the same as the check's.
      if (violatesUniqueOn(error, "cnpj")) {
        throw new ShipperCnpjAlreadyExistsError();
      }

      if (violatesUniqueOn(error, "name")) {
        throw new ShipperNameAlreadyExistsError();
      }

      throw new AppError(
        "Houve um erro ao tentar criar o embarcador! Por favor, tente novamente.",
        500,
      );
    }

    // After the write: every open picker of the company refetches.
    sendCatalogChangedEvent(shipperData.businessId, "shipper");

    return created;
  }
}

export { CreateShipperUseCase };
