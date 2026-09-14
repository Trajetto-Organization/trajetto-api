import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IShipperRepository } from "../../repositories/IShipper-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { ShipperNameAlreadyExistsError } from "../errors/shipper-errors";
import { AppError } from "@/shared/errors/AppError";

import { Shipper, CreateShipperProps } from "../../dtos/shipper-dto";

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
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      shipperData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findShipperByName = await this.shipper.findShipperByName(
      shipperData.businessId,
      shipperData.name,
    );

    if (findShipperByName) {
      throw new ShipperNameAlreadyExistsError();
    }

    try {
      return await this.shipper.createShipper(shipperData);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o embarcador! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateShipperUseCase };
