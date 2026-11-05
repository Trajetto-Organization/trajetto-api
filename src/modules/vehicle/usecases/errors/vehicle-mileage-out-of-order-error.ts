import type {
  OdometerNeighbours,
  OdometerTimeline,
} from "@/shared/vehicle/odometer-timeline";
import {
  SAME_READING_WINDOW_MINUTES,
  standsStillWith,
} from "@/modules/fuel/usecases/fuel-rules";

import { VehicleMileageInvalidError } from "./vehicle-mileage-invalid-error";

const km = (value: number) =>
  `${new Intl.NumberFormat("pt-BR").format(value)} km`;

/**
 * The bounds the reading may also EQUAL: the record holding it is less than
 * SAME_READING_WINDOW_MINUTES away (standsStillWith, placeReading's rule).
 */
interface EqualBounds {
  before: boolean;
  after: boolean;
}

const STRICT: EqualBounds = { before: false, after: false };

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

  constructor(neighbours: OdometerNeighbours, equal: EqualBounds = STRICT) {
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

    // A bound whose record is minutes away may be repeated (05/11/2026):
    // "maior que" alone would send the office to type 1 km more.
    const repeatable = [
      equal.before && before !== null ? km(before) : null,
      equal.after && after !== null ? km(after) : null,
    ].filter((value): value is string => value !== null);

    if (repeatable.length > 0) {
      this.message += ` Também pode ser igual a ${repeatable.join(" ou ")}, de um registro com menos de ${SAME_READING_WINDOW_MINUTES} minutos de diferença.`;
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
 * plain one. With the record's date, a bound it may equal (standing still)
 * says so; without it, the strict sentence.
 */
function editedReadingRefusal(
  sameVehicle: boolean,
  { neighbours, laterDay }: Pick<OdometerTimeline, "neighbours" | "laterDay">,
  record?: { at: Date; timeZone: string },
): VehicleMileageInvalidError {
  const bounds: OdometerNeighbours = {
    before: neighbours.before,
    after: laterDay === null ? null : neighbours.after,
  };

  const bounded = bounds.before !== null || bounds.after !== null;

  const equal: EqualBounds = record
    ? {
        before:
          bounds.before !== null &&
          standsStillWith(record, neighbours.beforeReading),
        after:
          bounds.after !== null &&
          standsStillWith(record, neighbours.afterReading),
      }
    : STRICT;

  return sameVehicle && bounded
    ? new VehicleMileageOutOfOrderError(bounds, equal)
    : new VehicleMileageInvalidError();
}

export { VehicleMileageOutOfOrderError, editedReadingRefusal };
export type { EqualBounds };
