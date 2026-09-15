import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IShipperRepository } from "../../repositories/IShipper-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import {
  ShipperNotFoundError,
  ShipperNotBelongBusinessError,
  ShipperHasDeliveriesError,
} from "../errors/shipper-errors";

import { AppError } from "@/shared/errors/AppError";

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
  }
}

export { DeleteShipperUseCase };
