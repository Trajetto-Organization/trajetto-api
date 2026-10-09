import { AppError } from "@/shared/errors/AppError";

class ServiceOrderPartAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Esta peça já foi adicionada a esta ordem de serviço! Altere a quantidade do lançamento existente.",
      409,
      "SERVICE_ORDER_PART_ALREADY_EXISTS",
    );
  }
}

export { ServiceOrderPartAlreadyExistsError };
