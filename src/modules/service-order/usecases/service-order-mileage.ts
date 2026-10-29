import type { Prisma } from "@prisma/client";

import type { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { AppError } from "@/shared/errors/AppError";

/**
 * The mileage a finished service order records on its vehicle.
 *
 * Equal to the odometer is a valid answer: a vehicle that stood in the
 * workshop comes back with the reading it went in with, and refusing it made
 * people type +0.1 km to close the order (FLEET-SO-4). Only a reading behind
 * the odometer is wrong.
 */
function assertMileageNotBehind(mileage: number, currentMileage: number): void {
  if (mileage < currentMileage) {
    throw new AppError(
      `A nova quilometragem (${mileage} km) não pode ser menor que a quilometragem atual do veículo (${currentMileage} km).`,
      400,
      "SERVICE_ORDER_MILEAGE_BEHIND",
    );
  }
}

/**
 * Writes the order's mileage onto the vehicle, inside the order's
 * transaction.
 *
 * Ahead of the odometer, it moves it forward-only (IDEMP-15: the guard is in
 * the WHERE, judged against the row when the write lands). At the same
 * reading only the last maintenance is recorded: the odometer is not written
 * at all, so it cannot run backwards either.
 */
async function recordMaintenanceMileage(
  vehicles: IVehicleRepository,
  {
    vehicleId,
    businessId,
    mileage,
    currentMileage,
    maintenanceDate,
  }: {
    vehicleId: string;
    businessId: string;
    mileage: number;
    /** The reading the order was validated against. */
    currentMileage: number;
    maintenanceDate?: Date | string | null;
  },
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (mileage === currentMileage) {
    await vehicles.updateVehicle(
      {
        vehicleId,
        vehicleData: {
          last_maintenance_mileage: mileage,
          ...(maintenanceDate && {
            last_maintenance_date: new Date(maintenanceDate),
          }),
        },
      },
      tx,
    );

    return;
  }

  const moved = await vehicles.advanceMileageAfterService(
    { vehicleId, businessId, mileage, maintenanceDate },
    tx,
  );

  if (!moved) {
    throw new AppError(
      `A nova quilometragem (${mileage} km) ficou atrás da quilometragem do veículo, que foi atualizada enquanto a ordem era registrada. Confira a quilometragem e tente novamente.`,
      400,
      "SERVICE_ORDER_MILEAGE_BEHIND",
    );
  }
}

/**
 * A corrected reading of an order that was already finished.
 *
 * It is judged against the order's own snapshot — the odometer when the
 * order was opened — not the live odometer: the next fuel-up moves that on,
 * and an honest correction (45 000 → 45 500 with the odometer at 50 000) was
 * refused, so the only value the form accepted was a false one. A reading
 * behind the opening one is still wrong: the vehicle cannot have gone back.
 *
 * Ahead of the odometer, the correction must be the vehicle's latest
 * maintenance: a later one was recorded at or below today's odometer, so an
 * older order cannot have finished past it.
 */
function assertCorrectionAccepted({
  mileage,
  openingMileage,
  currentMileage,
  isLatestMaintenance,
}: {
  mileage: number;
  /** current_mileage_at_service; null on legacy orders (no floor then). */
  openingMileage: number | null | undefined;
  currentMileage: number;
  isLatestMaintenance: boolean;
}): void {
  const hasOpening = openingMileage !== null && openingMileage !== undefined;

  if (hasOpening && mileage < openingMileage) {
    throw new AppError(
      `A quilometragem corrigida (${mileage} km) não pode ser menor que a do veículo na abertura da ordem (${openingMileage} km).`,
      400,
      "SERVICE_ORDER_MILEAGE_BEHIND",
    );
  }

  if (!isLatestMaintenance && mileage > currentMileage) {
    throw new AppError(
      `A quilometragem corrigida (${mileage} km) passa a atual do veículo (${currentMileage} km), e há uma manutenção registrada depois desta ordem. Confira o valor.`,
      400,
      "SERVICE_ORDER_MILEAGE_AHEAD",
    );
  }
}

/**
 * Writes a corrected reading onto the vehicle when this order is its latest
 * maintenance (the caller skips it otherwise: an older order's correction
 * must not overwrite a later maintenance). Ahead of the odometer both move,
 * forward-only as always; at or behind it only the last maintenance reading
 * follows, and the odometer stays. The maintenance date is kept: this is a
 * correction, not a new maintenance.
 */
async function recordMileageCorrection(
  vehicles: IVehicleRepository,
  {
    vehicleId,
    businessId,
    mileage,
  }: { vehicleId: string; businessId: string; mileage: number },
  tx: Prisma.TransactionClient,
): Promise<void> {
  const moved = await vehicles.advanceMileageAfterService(
    { vehicleId, businessId, mileage },
    tx,
  );

  if (moved) return;

  await vehicles.updateVehicle(
    { vehicleId, vehicleData: { last_maintenance_mileage: mileage } },
    tx,
  );
}

export {
  assertCorrectionAccepted,
  assertMileageNotBehind,
  recordMaintenanceMileage,
  recordMileageCorrection,
};
