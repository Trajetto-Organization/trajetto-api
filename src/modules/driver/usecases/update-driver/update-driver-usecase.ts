import { inject, injectable } from "tsyringe";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IUsersTokensRepository } from "@/modules/user/repositories/IUsers-tokens-repository";
import type { IDriverEnrollmentRepository } from "@/modules/user/repositories/IDriver-enrollment-repository";

import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { DriverNotFoundError } from "../errors/driver-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { DriverCpfAlreadyExistsError } from "../errors/driver-cpf-already-exists-error";
import { DriverLicenseAlreadyExistsError } from "../errors/driver-license-already-exists-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { driverUniqueViolation } from "../errors/driver-unique-violation";

import { NotificationService } from "@/shared/services/notification-service";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { sendCatalogChangedEvent, sendSecurityEventToUser } from "@/websocket";

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
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("DriverEnrollmentRepository")
    private driverEnrollment: IDriverEnrollmentRepository,
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

    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findDriverById = await this.driver.findDriverById(driverId);

    // One 404 for "does not exist" and "is not yours". Without this line,
    // anyone holding `driver_manage:write` rewrote another company's driver
    // (name, CPF, CNH) or marked them INACTIVE, which session-eligibility
    // turns into a forced logout of their app in the middle of a route.
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

    // Per company (decision 8.1), and never the driver being edited.
    if (driverData.cpf) {
      const sameCpf = await this.driver.findDriverByCpf(
        driverData.cpf,
        businessId,
      );

      if (sameCpf && sameCpf.id !== driverId) {
        throw new DriverCpfAlreadyExistsError();
      }
    }

    // No RG check: an RG repeats across states and was never an identity
    // (the CPF is); see create-driver.

    if (driverData.cnh) {
      const sameCnh = await this.driver.findDriverByCnh(
        driverData.cnh,
        businessId,
      );

      if (sameCnh && sameCnh.id !== driverId) {
        throw new DriverLicenseAlreadyExistsError();
      }
    }

    // A driver never moves between companies: the path names the company,
    // and the body cannot rewrite it.
    const { businessId: _ignored, ...changes } = driverData;

    let driverUpdated: Driver;

    try {
      // Deactivation with open routes is refused inside, under the driver
      // row's lock (DriverHasOpenRoutesError, decision 8.3).
      driverUpdated = await this.driver.updateDriver({
        driverData: changes,
        driverId,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;

      const duplicate = driverUniqueViolation(error);

      if (duplicate) throw duplicate;

      throw new AppError(
        "Houve um erro ao tentar atualizar o motorista! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "driver");

    /**
     * An inactive driver keeps nothing on the server (plan of 02/11/2026, D5).
     *
     * The security event only reached an open socket: the sessions and the
     * push devices stayed, so the phone kept receiving the driver's messages,
     * and an access QR code still on a screen could open a session the day
     * the driver was reactivated. Every session, its devices and the QR code
     * now go — on every save that asks for INACTIVE, not only the switch, so
     * a retry after a failure here still cleans up (each step is idempotent).
     *
     * The session version is left alone on purpose: the app's next request
     * then hears 403 AUTH_DRIVER_INACTIVE from the session check — why it is
     * being signed out — instead of a bare 401 "session ended".
     */
    if (changes.status === "INACTIVE") {
      const driverUser = await this.user.findUserByDriverId(driverId);

      if (driverUser) {
        await this.usersTokens.revokeAllUserRefreshTokens(driverUser.id);
        await this.driverEnrollment.revokeForUser(driverUser.id);

        if (findDriverById.status !== "INACTIVE") {
          sendSecurityEventToUser(driverUser.id, {
            reason: "driver_inactive",
          });
        }
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
  }
}

export { UpdateDriverUseCase };
