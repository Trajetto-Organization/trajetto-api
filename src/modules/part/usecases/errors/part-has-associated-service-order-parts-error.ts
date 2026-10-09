import { AppError } from "@/shared/errors/AppError";

/**
 * A part used by service orders stays: the order lines point at it (the
 * foreign key refuses the delete), and they are the history of what was
 * spent on each vehicle.
 */
class PartHasAssociatedServiceOrderPartsError extends AppError {
  constructor(serviceOrderPartCount: number) {
    super(
      `Não é possível excluir esta peça: ela está em ${serviceOrderPartCount} lançamento(s) de ordem de serviço, que fazem parte do histórico de custos dos veículos. ` +
        "Para removê-la, retire-a dessas ordens de serviço antes.",
      409,
      "PART_IN_USE",
    );
  }
}

export { PartHasAssociatedServiceOrderPartsError };
