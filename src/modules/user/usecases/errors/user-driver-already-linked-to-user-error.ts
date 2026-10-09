import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class UserDriverAlreadyLinkedToUserError extends AppError {
  constructor() {
    super("Este motorista já está vinculado a outro usuário.", 409, "DRIVER_ALREADY_LINKED");
  }
}

export { UserDriverAlreadyLinkedToUserError };
