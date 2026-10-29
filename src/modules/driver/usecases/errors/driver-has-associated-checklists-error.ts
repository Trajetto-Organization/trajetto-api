import { AppError } from "@/shared/errors/AppError";

class DriverHasAssociatedChecklistsError extends AppError {
  constructor(checklistCount: number) {
    super(
      `Não é possível deletar este motorista pois existem ${checklistCount} checklist(s) associado(s). ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir checklists para outro motorista (recomendado)\n` +
        `• Deletar checklists pendentes antes de deletar`,
      409,
      "DRIVER_HAS_CHECKLISTS",
    );
  }
}

export { DriverHasAssociatedChecklistsError };
