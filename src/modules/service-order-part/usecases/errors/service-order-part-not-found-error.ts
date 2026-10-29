import { AppError } from "@/shared/errors/AppError";

class ServiceOrderPartNotFoundError extends AppError {
  constructor() {
    super(
      "Peça da ordem de serviço não encontrada!",
      404,
      "SERVICE_ORDER_PART_NOT_FOUND",
    );
  }
}

export { ServiceOrderPartNotFoundError };
