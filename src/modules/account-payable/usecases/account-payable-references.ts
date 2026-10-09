import type { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import type { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import type { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { AccountPayableReferenceError } from "./errors/account-payable-reference-error";

interface AccountPayableReferenceRepositories {
  branch: IBranchRepository;
  serviceOrder: IServiceOrderRepository;
  supplier: ISupplierRepository;
  vehicle: IVehicleRepository;
  user: IUserRepository;
}

/** The ids a bill points at; an absent or null one is not checked. */
interface AccountPayableReferences {
  branchId?: string | null;
  serviceOrderId?: string | null;
  supplierId?: string | null;
  vehicleId?: string | null;
  registrationUserId?: string | null;
}

interface CheckedReferences {
  /** The service order, when one was named: its total feeds FLEET-AP-5. */
  serviceOrder: { total_amount: unknown } | null;
}

/**
 * Every record a bill points at belongs to the bill's company — branch,
 * service order, payee, cost-centre vehicle and the responsible person, who
 * is notified with the amount (so a stranger must never be one). Create and
 * update ask the same questions, so they refuse with the same words.
 */
async function assertAccountPayableReferences(
  repositories: AccountPayableReferenceRepositories,
  businessId: string,
  references: AccountPayableReferences,
): Promise<CheckedReferences> {
  const belongs = (record: { businessId?: string | null } | null) =>
    record !== null && record.businessId === businessId;

  if (references.branchId) {
    const branch = await repositories.branch.findBranchById(references.branchId);

    if (!belongs(branch)) throw new AccountPayableReferenceError("branch");
  }

  let serviceOrder: CheckedReferences["serviceOrder"] = null;

  if (references.serviceOrderId) {
    const found = await repositories.serviceOrder.findServiceOrderById(
      references.serviceOrderId,
    );

    if (!belongs(found)) throw new AccountPayableReferenceError("serviceOrder");

    serviceOrder = found as { total_amount: unknown };
  }

  if (references.supplierId) {
    const supplier = await repositories.supplier.findSupplierById(
      references.supplierId,
    );

    if (!belongs(supplier)) throw new AccountPayableReferenceError("supplier");
  }

  if (references.vehicleId) {
    const vehicle = await repositories.vehicle.findVehicleById(
      references.vehicleId,
    );

    if (!belongs(vehicle)) throw new AccountPayableReferenceError("vehicle");
  }

  if (references.registrationUserId) {
    const responsible = await repositories.user.findUserById(
      references.registrationUserId,
    );

    if (!belongs(responsible)) {
      throw new AccountPayableReferenceError("responsible");
    }
  }

  return { serviceOrder };
}

export {
  assertAccountPayableReferences,
  type AccountPayableReferenceRepositories,
  type AccountPayableReferences,
};
