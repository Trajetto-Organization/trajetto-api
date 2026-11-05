import { SAME_READING_WINDOW_MINUTES } from "@/modules/fuel/usecases/fuel-rules";

class VehicleMileageInvalidError extends Error {
  constructor() {
    // "Maior que" alone stopped being the rule on 05/11/2026: a reading may
    // repeat a neighbouring record's km within SAME_READING_WINDOW_MINUTES
    // (fuel-rules.ts placeReading), both dated with the hour: a date that is
    // only the day (the web's) never stands still (standsStillWith).
    super(
      `A quilometragem informada deve ser maior que a quilometragem atual do veículo, ou igual à de outro registro com menos de ${SAME_READING_WINDOW_MINUTES} minutos de diferença, os dois com hora (não só o dia)!`,
    );
  }
}

export { VehicleMileageInvalidError };
