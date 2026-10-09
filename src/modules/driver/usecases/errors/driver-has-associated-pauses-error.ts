import { AppError } from "@/shared/errors/AppError";

/**
 * Pauses are the legal record of a driver's workday (Lei 13.103/2015), and
 * `driver_pause.driverId` is RESTRICT: without this guard the delete reached
 * the database and came back as a 500.
 */
class DriverHasAssociatedPausesError extends AppError {
  constructor(pauseCount: number) {
    super(
      `Não é possível excluir este motorista pois existem ${pauseCount} pausa(s) registrada(s) na jornada dele. ` +
        "As pausas são o registro legal da jornada. Inative o motorista para tirá-lo das listas sem perder o histórico.",
      409,
      "DRIVER_HAS_PAUSES",
    );
  }
}

export { DriverHasAssociatedPausesError };
