import { inject, injectable } from "tsyringe";

import type { IBusinessSettingsRepository } from "@/modules/business/repositories/IBusiness-settings-repository";
import type { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import type { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import type { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import {
  effectiveBusinessSettings,
  settingsOrDefaults,
} from "@/shared/business/business-settings";
import { hasModule } from "@/shared/entitlements/entitlement-service";
import {
  activeBranchLookups,
  resolveActiveRecordBranchId,
} from "@/shared/vehicle/record-branch";

import {
  RouteBranchInactiveError,
  RouteBranchRequiredError,
} from "../errors/route-errors";

interface RouteCrew {
  businessId: string;
  vehicleId: string | null | undefined;
  driverId: string;
}

/**
 * Whether the route's checklist can be filed, asked where the dispatcher can
 * still fix it (contract C1 of 03/11/2026; the product principle: never
 * block the driver over an admin's data gap, show it to the dispatcher).
 *
 * A company that asks for the route checklist (checklist_requirement other
 * than NONE, with the module rule of M6 applied) holds the driver's "Iniciar
 * rota" for the departure checklist, and the driver's checklist is filed
 * under an ACTIVE branch: the vehicle's, else the driver's, else the
 * company's single active branch, skipping any that is switched off
 * (`resolveActiveRecordBranchId`, shared/vehicle/record-branch, wave 3.7).
 * The guard asks exactly that question. When nothing active resolves, the
 * checklist would be refused with BRANCH_REQUIRED, so releasing such a route
 * — or changing the vehicle or driver of one already released — answers 409
 * ROUTE_BRANCH_REQUIRED instead, naming the plate and the driver whose branch
 * is missing; or, when the vehicle or the driver names a branch that is
 * switched off, a sentence naming that branch, which is what to fix. An
 * inactive branch with an active one to fall back on refuses nothing: the
 * checklist goes under the fallback.
 *
 * Cheap for the common case: a company that never asked for the checklist
 * reads only its settings row.
 */
@injectable()
class RouteBranchGuard {
  constructor(
    @inject("BusinessSettingsRepository")
    private settings: Pick<IBusinessSettingsRepository, "findByBusinessId">,
    @inject("VehicleRepository")
    private vehicles: Pick<IVehicleRepository, "findVehicleById">,
    @inject("DriverRepository")
    private drivers: Pick<IDriverRepository, "findDriverById">,
    @inject("BranchRepository")
    private branches: Pick<
      IBranchRepository,
      "findSoleActiveBranchId" | "findBranchById"
    >,
  ) {}

  async assertResolvable({
    businessId,
    vehicleId,
    driverId,
  }: RouteCrew): Promise<void> {
    const stored = await this.settings.findByBusinessId(businessId);

    if (settingsOrDefaults(stored).checklist_requirement === "NONE") return;

    // The route checklist needs the fleet and the deliveries (M6); the
    // release is already behind the deliveries module, so the fleet decides.
    const enabledModules = (await hasModule(businessId, "FLEET"))
      ? ["FLEET", "DELIVERIES"]
      : ["DELIVERIES"];

    if (
      effectiveBusinessSettings(stored, enabledModules)
        .checklist_requirement === "NONE"
    ) {
      return;
    }

    const [vehicle, driver] = await Promise.all([
      vehicleId ? this.vehicles.findVehicleById(vehicleId) : null,
      this.drivers.findDriverById(driverId),
    ]);

    // Rows of another company never lend their branch (the use cases have
    // already refused them; this only keeps the guard honest on its own).
    const ownVehicle = vehicle?.businessId === businessId ? vehicle : null;
    const ownDriver = driver?.businessId === businessId ? driver : null;

    const lookups = activeBranchLookups(this.branches, businessId);

    const branchId = await resolveActiveRecordBranchId(
      {
        vehicleBranchId: ownVehicle?.branchId,
        driverBranchId: ownDriver?.branchId,
      },
      lookups,
    );

    if (branchId) return;

    // Nothing active resolves. A branch of this company that the vehicle or
    // the driver names but is switched off is what the dispatcher fixes
    // (reactivate it, or move the record elsewhere): name it. The rows were
    // read by the resolution above; no branch is read twice.
    const named = [
      ownVehicle?.branchId
        ? {
            branchId: ownVehicle.branchId,
            holder: {
              kind: "vehicle" as const,
              plate: ownVehicle.license_plate,
            },
          }
        : null,
      ownDriver?.branchId
        ? {
            branchId: ownDriver.branchId,
            holder: { kind: "driver" as const, name: ownDriver.name },
          }
        : null,
    ];

    for (const candidate of named) {
      if (!candidate) continue;

      const branch = await lookups.rowOf(candidate.branchId);

      if (branch?.is_active === false) {
        throw new RouteBranchInactiveError(
          branch.corporate_reason,
          candidate.holder,
        );
      }
    }

    throw new RouteBranchRequiredError(
      ownVehicle?.license_plate ?? null,
      ownDriver?.name ?? null,
    );
  }
}

export { RouteBranchGuard };
export type { RouteCrew };
