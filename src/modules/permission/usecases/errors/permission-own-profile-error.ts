import { AppError } from "@/shared/errors/AppError";
import { ACCESS_ERROR_CODES } from "@/shared/errors/access-errors";

/**
 * A BUSINESS_USER never changes what their own profile may do: with the
 * write permission they could otherwise grant themselves every other one.
 * The lists already hide the profile from them; this is the write side.
 */
class PermissionOwnProfileError extends AppError {
  constructor() {
    super(
      "Você não pode alterar as permissões do seu próprio perfil de acesso.",
      403,
      ACCESS_ERROR_CODES.PERMISSION_DENIED,
    );
  }
}

interface ProfileHolder {
  role: string;
  profileAccessId?: string | null;
}

/** Refuses when `profileAccessId` is the actor's own profile. */
function assertNotOwnProfile(
  actor: ProfileHolder,
  profileAccessId: string | null | undefined,
): void {
  if (
    actor.role === "BUSINESS_USER" &&
    !!actor.profileAccessId &&
    actor.profileAccessId === profileAccessId
  ) {
    throw new PermissionOwnProfileError();
  }
}

export { PermissionOwnProfileError, assertNotOwnProfile };
