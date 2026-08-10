import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { AppError } from "@/shared/errors/AppError";
import { User } from "../dtos/user-dto";

interface EligibleSession {
  driver: { id: string; branchId: string | null } | null;
}

async function assertSessionEligible(
  user: User,
  driverRepository: IDriverRepository,
): Promise<EligibleSession> {
  if (user.access_revoked) {
    throw new AppError(
      "Seu acesso foi revogado. Entre em contato com o administrador.",
      403,
      "AUTH_ACCESS_REVOKED",
    );
  }

  if (user.role !== "MASTER" && !user.businessId) {
    throw new AppError(
      "Usuário não está associado a uma empresa.",
      403,
      "AUTH_BUSINESS_REQUIRED",
    );
  }

  if (user.business?.is_active === false) {
    throw new AppError(
      "Esta empresa está desativada. Entre em contato com o administrador.",
      403,
      "AUTH_BUSINESS_INACTIVE",
    );
  }

  let driver: EligibleSession["driver"] = null;

  if (user.driverId) {
    const driverRecord = await driverRepository.findDriverById(user.driverId);

    if (!driverRecord || driverRecord.status !== "ACTIVE") {
      throw new AppError(
        "Seu cadastro como motorista está inativo ou indisponível.",
        403,
        "AUTH_DRIVER_INACTIVE",
      );
    }

    if (driverRecord.businessId !== user.businessId) {
      throw new AppError(
        "O motorista não pertence à empresa do usuário.",
        403,
        "AUTH_DRIVER_TENANT_MISMATCH",
      );
    }

    if (driverRecord.branch?.is_active === false) {
      throw new AppError(
        "A filial do motorista está desativada.",
        403,
        "AUTH_BRANCH_INACTIVE",
      );
    }

    driver = { id: driverRecord.id, branchId: driverRecord.branchId ?? null };
  }

  if (user.role === "BUSINESS_USER") {
    const hasPermissions = Boolean(user.profileAccess?.permissions?.length);

    if (!hasPermissions && !driver) {
      throw new AppError(
        "Perfil de acesso ou motorista não associado ao usuário.",
        403,
        "AUTH_PROFILE_NOT_CONFIGURED",
      );
    }
  }

  return { driver };
}

export { assertSessionEligible };
