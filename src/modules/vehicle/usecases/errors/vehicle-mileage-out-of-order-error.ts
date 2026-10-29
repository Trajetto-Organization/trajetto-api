import type {
  OdometerNeighbours,
  OdometerTimeline,
} from "@/shared/vehicle/odometer-timeline";

import { VehicleMileageInvalidError } from "./vehicle-mileage-invalid-error";

const km = (value: number) =>
  `${new Intl.NumberFormat("pt-BR").format(value)} km`;

/**
 * An edit whose km, or whose new date, would put the reading out of order
 * among the vehicle's records around that date.
 *
 * The plain refusal says "must be greater than the vehicle's current
 * mileage": wrong for a correction, where a value below the odometer is
 * fine, and meaningless to someone who only changed the DATE. This one names
 * the bounds the record has to fit. A subclass, so every handler of the
 * plain refusal (the use cases' rethrow, the outbox's permanent class) still
 * treats it as one.
 */
class VehicleMileageOutOfOrderError extends VehicleMileageInvalidError {
  readonly neighbours: OdometerNeighbours;

  constructor(neighbours: OdometerNeighbours) {
    super();

    this.neighbours = neighbours;

    const { before, after } = neighbours;
    const prefix =
      "A quilometragem ficaria fora de ordem no histórico do veículo: nessa data, ela precisa";

    if (before !== null && after !== null) {
      this.message = `${prefix} ficar entre ${km(before)} e ${km(after)}, as leituras dos registros anterior e seguinte.`;
    } else if (before !== null) {
      this.message = `${prefix} ser maior que ${km(before)}, a leitura do registro anterior.`;
    } else if (after !== null) {
      this.message = `${prefix} ser menor que ${km(after)}, a leitura do registro seguinte.`;
    }
  }
}

/**
 * The refusal for an edit placeReading turned down (the fueling and
 * checklist edits' rule). On its own vehicle the record is refused only for
 * leaving the bounds of its neighbours, so they explain it; a reading after
 * it on the SAME civil day binds only when a later day has one too (the web
 * dates a record at local midnight, the app at the moment itself). Moved to
 * another vehicle it follows the create's rule there, whose sentence is the
 * plain one.
 */
function editedReadingRefusal(
  sameVehicle: boolean,
  { neighbours, laterDay }: Pick<OdometerTimeline, "neighbours" | "laterDay">,
): VehicleMileageInvalidError {
  const bounds: OdometerNeighbours = {
    before: neighbours.before,
    after: laterDay === null ? null : neighbours.after,
  };

  const bounded = bounds.before !== null || bounds.after !== null;

  return sameVehicle && bounded
    ? new VehicleMileageOutOfOrderError(bounds)
    : new VehicleMileageInvalidError();
}

export { VehicleMileageOutOfOrderError, editedReadingRefusal };
