import { inject, injectable } from "tsyringe";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { DriverCpfAlreadyExistsError } from "../errors/driver-cpf-already-exists-error";

import { DriverLicenseAlreadyExistsError } from "../errors/driver-license-already-exists-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { DriverRgAlreadyExistsError } from "../errors/driver-rg-already-exists-error";

import { NotificationService } from "@/shared/services/notification-service";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { Driver, CreateDriverProps } from "../../dtos/driver-dto";

@injectable()
class CreateDriverUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    driverData: CreateDriverProps,
    userId: string,
  ): Promise<Driver> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      driverData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Check the branch if it was provided
    if (driverData.branchId) {
      const findBranch = await this.branch.findBranchById(driverData.branchId);

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      // Check if the branch belongs to the same company
      if (findBranch.businessId !== driverData.businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    // Check if there is already a driver with the same CPF
    const findDriverByCpf = await this.driver.findDriverByCpf(driverData.cpf);

    if (findDriverByCpf) {
      throw new DriverCpfAlreadyExistsError();
    }

    // Check if there is already a driver with the same RG
    const findDriverByRG = await this.driver.findDriverByRg(driverData.rg);

    if (findDriverByRG) {
      throw new DriverRgAlreadyExistsError();
    }

    // Check if there is already a driver with the same driver's license
    const findDriverByDriverLicense =
      await this.driver.findDriverByDriverLicense(driverData.cnh);

    if (findDriverByDriverLicense) {
      throw new DriverLicenseAlreadyExistsError();
    }

    try {
      const driverCreated = await this.driver.createDriver(driverData);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Motorista",
        action: "create",
        entityId: driverCreated.id,
        description: `Motorista criado com sucesso: ${driverCreated.name} | CNH: ${driverCreated.cnh} | CPF: ${driverCreated.cpf} | ID: ${driverCreated.id}`,
        status: "Completo",
        performedBy: userId,
        businessId: driverData.businessId,
      });

      return driverCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o motorista! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateDriverUseCase };
