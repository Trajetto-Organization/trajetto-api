import { AppError } from "@/shared/errors/AppError";

class DriverHasAssociatedFinesError extends AppError {
  constructor(fineCount: number) {
    super(
      `Não é possível deletar este motorista pois existem ${fineCount} multa(s) associada(s). ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir multas para outro motorista (recomendado)\n` +
        `• Resolver/pagar multas pendentes antes de deletar`,
      409,
      "DRIVER_HAS_FINES",
    );
  }
}

export { DriverHasAssociatedFinesError };
