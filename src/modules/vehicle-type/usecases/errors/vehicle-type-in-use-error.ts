import { AppError } from "@/shared/errors/AppError";

/**
 * Deleting a type still on vehicles (FLEET-VTYPE-2). The foreign key is SET
 * NULL, so the delete used to succeed and quietly turn every one of those
 * vehicles into "Outros" in the charts; the fuel type, its sibling
 * catalogue, already refused the same case.
 */
class VehicleTypeInUseError extends AppError {
  constructor(vehicleCount: number) {
    super(
      `Não é possível excluir este tipo de veículo: ${vehicleCount} veículo(s) usam este tipo. ` +
        "Troque o tipo desses veículos antes de excluí-lo.",
      409,
      "VEHICLE_TYPE_IN_USE",
    );
  }
}

export { VehicleTypeInUseError };
