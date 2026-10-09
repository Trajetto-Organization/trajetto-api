import { AppError } from "@/shared/errors/AppError";

class DriverHasAssociatedFuelError extends AppError {
  constructor(fuelCount: number) {
    super(
      `Não é possível deletar este motorista pois existem ${fuelCount} registro(s) de abastecimento associado(s). ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir registros de combustível para outro motorista (recomendado)\n` +
        `• Excluir registros de combustível antes de deletar o motorista`,
      409,
      "DRIVER_HAS_FUELS",
    );
  }
}

export { DriverHasAssociatedFuelError };
