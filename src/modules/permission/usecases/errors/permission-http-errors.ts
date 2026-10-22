import type { HttpErrorRule } from "@/shared/errors/http-error-rules";

import { ProfileAccessNotFoundError } from "@/modules/profile-access/usecases/errors/profile-access-not-found-error";
import { UserProfileAccessNotFoundError } from "@/modules/user/usecases/errors/user-profile-access-not-found-error";

import { PermissionBusinessError } from "./permission-business-error";

/**
 * The permission writes name the access profile in the BODY, so a profile
 * that does not resolve (missing or another company's — one answer) is the
 * request being wrong: 400, with the same code the path routes answer 404
 * with (shared/errors/http-error-rules.ts).
 *
 * One sentence for all three: the update said "Perfil de acesso não
 * encontrado!" for a missing profile and a longer sentence for another
 * company's, which told the two apart.
 */
const PROFILE_NOT_FOUND_SENTENCE = new UserProfileAccessNotFoundError().message;

const PERMISSION_BODY_LINK_RULES: readonly HttpErrorRule[] = [
  [UserProfileAccessNotFoundError, 400, "PROFILE_ACCESS_NOT_FOUND"],
  [
    ProfileAccessNotFoundError,
    400,
    "PROFILE_ACCESS_NOT_FOUND",
    PROFILE_NOT_FOUND_SENTENCE,
  ],
  [
    PermissionBusinessError,
    400,
    "PROFILE_ACCESS_NOT_FOUND",
    PROFILE_NOT_FOUND_SENTENCE,
  ],
];

export { PERMISSION_BODY_LINK_RULES };
