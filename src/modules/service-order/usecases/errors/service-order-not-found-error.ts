import { AppError } from "@/shared/errors/AppError";

/**
 * Also the answer for another company's order: a 403 "não pertence a esta
 * empresa" beside a 404 for an id that exists nowhere told any manager which
 * order ids exist in other companies (decision 11.3).
 */
class ServiceOrderNotFoundError extends AppError {
  constructor() {
    super("Ordem de serviço não encontrada!", 404, "SERVICE_ORDER_NOT_FOUND");
  }
}

export { ServiceOrderNotFoundError };
