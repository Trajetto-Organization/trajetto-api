import { AppError } from "@/shared/errors/AppError";

import { UserProfileAccessNotFoundError } from "@/modules/user/usecases/errors/user-profile-access-not-found-error";

/**
 * Another company's access profile, answered exactly like a missing one
 * (decision 11.3): a distinct 403 confirmed the id exists in another tenant.
 */
class PermissionBusinessError extends AppError {
  constructor() {
    super(
      new UserProfileAccessNotFoundError().message,
      404,
      "PROFILE_ACCESS_NOT_FOUND",
    );
  }
}

export { PermissionBusinessError };
