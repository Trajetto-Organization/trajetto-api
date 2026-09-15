import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IShipperRepository } from "../../repositories/IShipper-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import {
  ShipperNotFoundError,
  ShipperNameAlreadyExistsError,
  ShipperNotBelongBusinessError,
} from "../errors/shipper-errors";

import { AppError } from "@/shared/errors/AppError";
import { Shipper, UpdateShipperProps } from "../../dtos/shipper-dto";

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
      throw new ResourceNotFoundError();
    }

    // O catálogo da operação é do despachante. `delivery_manage` e
    // `occurrence_manage` são abertos ao motorista de propósito — o
    // aplicativo dele roda nessas permissões —, então a tabela de
    // permissões diz sim e a use case diz não. O módulo de motivos de
    // status, na MESMA chave, já fazia isto nas três escritas.
    assertDispatcher(findUser);

    const findShipper = await this.shipper.findShipperById(shipperId);

    if (!findShipper) {
      throw new ShipperNotFoundError();
    }

    if (findShipper.businessId !== businessId) {
      throw new ShipperNotBelongBusinessError();
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

    try {
      return await this.shipper.updateShipper(shipperId, shipperData);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o embarcador! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateShipperUseCase };
