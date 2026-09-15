import { inject, injectable } from "tsyringe";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { DriverNotFoundError } from "../errors/driver-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { DriverCpfAlreadyExistsError } from "../errors/driver-cpf-already-exists-error";
import { DriverRgAlreadyExistsError } from "../errors/driver-rg-already-exists-error";

import { DriverLicenseAlreadyExistsError } from "../errors/driver-license-already-exists-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { NotificationService } from "@/shared/services/notification-service";
import { sendSecurityEventToUser } from "@/websocket";

import { Driver, UpdateDriverProps } from "../../dtos/driver-dto";

@injectable()
class UpdateDriverUseCase {
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
    driverData: UpdateDriverProps,
    driverId: string,
    userId: string,
    businessId: string,
  ): Promise<Driver> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findDriverById = await this.driver.findDriverById(driverId);

    // O mesmo 404 para "não existe" e "não é seu". Sem esta linha,
    // qualquer usuário com `driver_manage:write` reescrevia o motorista
    // de outra empresa — nome, CPF, CNH — ou o marcava INACTIVE, que o
    // `session-eligibility` transforma em logout forçado do aplicativo
    // dele no meio da rota.
    if (!findDriverById || findDriverById.businessId !== businessId) {
      throw new DriverNotFoundError();
    }

    if (driverData.branchId) {
      const findBranch = await this.branch.findBranchById(driverData.branchId);

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    if (driverData.cpf) {
      // Check if there is already a driver with the same CPF
      const findDriverByCpf = await this.driver.findDriverByCpf(driverData.cpf);

      if (findDriverByCpf && findDriverByCpf.id !== driverId) {
        throw new DriverCpfAlreadyExistsError();
      }
    }

    if (driverData.rg) {
      // Check if there is already a driver with the same RG
      const findDriverByRG = await this.driver.findDriverByRg(driverData.rg);

      if (findDriverByRG && findDriverByRG.id !== driverId) {
        throw new DriverRgAlreadyExistsError();
      }
    }

    if (driverData.cnh) {
      // Check if there is already a driver with the same driver's license
      const findDriverByDriverLicense =
        await this.driver.findDriverByDriverLicense(driverData.cnh);

      if (
        findDriverByDriverLicense &&
        findDriverByDriverLicense.id !== driverId
      ) {
        throw new DriverLicenseAlreadyExistsError();
      }
    }

    try {
      const driverUpdated = await this.driver.updateDriver({
        driverData,
        driverId,
      });

      // If the driver was just deactivated, notify the linked user in real-time
      if (
        driverData.status === "INACTIVE" &&
        findDriverById.status !== "INACTIVE"
      ) {
        const driverUser = await this.user.findUserByDriverId(driverId);
        if (driverUser) {
          sendSecurityEventToUser(driverUser.id, { reason: "driver_inactive" });
        }
      }

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Motorista",
        action: "update",
        entityId: driverUpdated.id,
        description: `Motorista atualizado com sucesso: ${driverUpdated.name} | CNH: ${driverUpdated.cnh} | ID: ${driverUpdated.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId: businessId,
      });

      return driverUpdated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o motorista! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateDriverUseCase };
