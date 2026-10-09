import { AppError } from "@/shared/errors/AppError";

import { UserProfileAccessNotFoundError } from "./user-profile-access-not-found-error";

/**
 * Another company's access profile, answered exactly like a missing one
 * (decision 11.3): a distinct 403 "não pertence à mesma empresa" told the
 * caller the id is real in some other tenant.
 */
class UserProfileNotMatchBusinessError extends AppError {
  constructor() {
    super(
      new UserProfileAccessNotFoundError().message,
      404,
      "PROFILE_ACCESS_NOT_FOUND",
    );
  }
}

export { UserProfileNotMatchBusinessError };
