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
import { driverUniqueViolation } from "../errors/driver-unique-violation";

import { NotificationService } from "@/shared/services/notification-service";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { sendCatalogChangedEvent } from "@/websocket";

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

    // The route's tenant guard already refuses another company's id in the
    // path; the use case does not rely on being reached only through it.
    assertTenantAccess(findUser, driverData.businessId);

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

    // CPF and CNH are unique per company (decision 8.1): only this company's
    // drivers are asked, so the answer can never say anything about another.
    if (await this.driver.findDriverByCpf(driverData.cpf, driverData.businessId)) {
      throw new DriverCpfAlreadyExistsError();
    }

    // No RG check: an RG is issued per state and repeats across states, so it
    // was never an identity (the CPF is). Its unique was dropped in
    // 20260924090400_tenant_scoped_uniques.

    if (await this.driver.findDriverByCnh(driverData.cnh, driverData.businessId)) {
      throw new DriverLicenseAlreadyExistsError();
    }

    let driverCreated: Driver;

    try {
      driverCreated = await this.driver.createDriver(driverData);
    } catch (error) {
      const duplicate = driverUniqueViolation(error);

      if (duplicate) throw duplicate;

      throw new AppError(
        "Houve um erro ao tentar criar o motorista! Por favor, tente novamente.",
        500,
      );
    }

    // After the write: every open picker of this company refetches its
    // drivers (decision 2.3).
    sendCatalogChangedEvent(driverData.businessId, "driver");

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
  }
}

export { CreateDriverUseCase };
