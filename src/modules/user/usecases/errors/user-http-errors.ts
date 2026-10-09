import type { HttpErrorRule } from "@/shared/errors/http-error-rules";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { UserProfileAccessNotFoundError } from "./user-profile-access-not-found-error";
import { UserProfileNotMatchBusinessError } from "./user-profile-not-match-business-error";

/**
 * Editing a user names the driver and the access profile in the BODY: one
 * that does not resolve (missing or another company's — the same answer) is
 * the request being wrong, 400 with the thing's code, as the vehicle and
 * maintenance routes answer the same links. The company is never in an edit
 * body: a user stays in the company it was created in (decision 16.100).
 */
const USER_UPDATE_LINK_RULES: readonly HttpErrorRule[] = [
  [DriverNotFoundError, 400, "DRIVER_NOT_FOUND"],
  [DriverNotBelongBusinessError, 400, "DRIVER_NOT_FOUND"],
  [UserProfileAccessNotFoundError, 400, "PROFILE_ACCESS_NOT_FOUND"],
  [UserProfileNotMatchBusinessError, 400, "PROFILE_ACCESS_NOT_FOUND"],
];

/**
 * Creating a user also names its company in the body (the route has none in
 * its path), so a company that does not exist is a 400 too.
 */
const USER_BODY_LINK_RULES: readonly HttpErrorRule[] = [
  [BusinessNotFoundError, 400, "BUSINESS_NOT_FOUND"],
  ...USER_UPDATE_LINK_RULES,
];

export { USER_BODY_LINK_RULES, USER_UPDATE_LINK_RULES };
