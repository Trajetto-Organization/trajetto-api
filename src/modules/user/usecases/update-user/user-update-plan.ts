import type { UserRole } from "../../dtos/user-dto";

/**
 * What an edit of a user actually changes, decided by comparing VALUES with
 * the stored row — never by which fields the request happened to carry.
 *
 * The web sends the whole form (company, e-mail, name, role…) on every save,
 * and the use case used to treat the mere presence of a field as a security
 * change: renaming somebody logged them out of the web and the app
 * (USR-EDIT-1). Decision 4.6: a change of role or driver link ends the
 * person's sessions and clears their inbox; anything else does not. The
 * company is not an input at all: no edit moves a person (decision 16.100).
 *
 * Pure: the use case validates the references it names (profile, driver)
 * and runs the writes.
 */

interface UserSnapshot {
  role: UserRole;
  email: string;
  name: string;
  businessId?: string | null;
  profileAccessId?: string | null;
  driverId?: string | null;
}

interface UserUpdateInput {
  email?: string | null;
  name?: string | null;
  role?: UserRole | null;
  /** `""` or null unlinks; undefined leaves it as it is. */
  profileAccessId?: string | null;
  /** `""` or null unlinks; undefined leaves it as it is. */
  driverId?: string | null;
}

interface UserUpdateChanges {
  email: boolean;
  name: boolean;
  role: boolean;
  profile: boolean;
  driver: boolean;
}

/** The columns to write: only what differs from the stored row. */
interface UserUpdateData {
  email?: string;
  name?: string;
  role?: UserRole;
  profileAccessId?: string | null;
  driverId?: string | null;
}

type UserUpdatePlanError =
  /** Both a profile and a driver would end up linked. */
  | "both_profile_and_driver"
  /** A BUSINESS_USER whose link changed ends with neither. */
  | "assignment_required";

type UserUpdatePlan =
  | {
      ok: true;
      next: Required<UserSnapshot>;
      changes: UserUpdateChanges;
      data: UserUpdateData;
      /** Anything at all differs from the stored row. */
      changed: boolean;
      /**
       * Role or driver link changed (decision 4.6): the session is
       * bumped, refresh tokens and push devices go, the inbox is cleared.
       */
      endsSessions: boolean;
    }
  | { ok: false; error: UserUpdatePlanError };

/** Undefined stays "not sent"; "" and null both mean "unlink". */
function linkInput(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;

  return value && value.trim() !== "" ? value : null;
}

/** For the non-nullable columns an empty value is "not sent", never a blank. */
function presentText(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function planUserUpdate(
  before: UserSnapshot,
  input: UserUpdateInput,
): UserUpdatePlan {
  const current = {
    role: before.role,
    email: before.email,
    name: before.name,
    businessId: before.businessId ?? null,
    profileAccessId: before.profileAccessId ?? null,
    driverId: before.driverId ?? null,
  };

  const role = input.role ?? current.role;
  const email = presentText(input.email) ?? current.email;
  const name = presentText(input.name) ?? current.name;
  const businessId = current.businessId;

  let profileAccessId: string | null;
  let driverId: string | null;

  if (role === "BUSINESS_ADMIN" || role === "MASTER") {
    // An administrator reads through the role, never through a profile, and
    // is not anybody's driver login.
    profileAccessId = null;
    driverId = null;
  } else {
    const profileInput = linkInput(input.profileAccessId);
    const driverInput = linkInput(input.driverId);

    if (profileInput && driverInput) {
      return { ok: false, error: "both_profile_and_driver" };
    }

    // Choosing one link replaces the other (USR-EDIT-3): a request carrying
    // only a profile used to leave the user with the profile AND the driver.
    if (profileInput !== undefined && driverInput === undefined) {
      profileAccessId = profileInput;
      driverId = profileInput ? null : current.driverId;
    } else if (driverInput !== undefined && profileInput === undefined) {
      driverId = driverInput;
      profileAccessId = driverInput ? null : current.profileAccessId;
    } else if (profileInput !== undefined && driverInput !== undefined) {
      profileAccessId = profileInput;
      driverId = driverInput;
    } else {
      profileAccessId = current.profileAccessId;
      driverId = current.driverId;
    }
  }

  const changes: UserUpdateChanges = {
    email: email !== current.email,
    name: name !== current.name,
    role: role !== current.role,
    profile: profileAccessId !== current.profileAccessId,
    driver: driverId !== current.driverId,
  };

  const assignmentTouched = changes.role || changes.profile || changes.driver;

  // Only when the link itself is being edited: a legacy user with neither
  // can still have a typo in the name fixed.
  if (
    role === "BUSINESS_USER" &&
    assignmentTouched &&
    !profileAccessId &&
    !driverId
  ) {
    return { ok: false, error: "assignment_required" };
  }

  const data: UserUpdateData = {
    ...(changes.email && { email }),
    ...(changes.name && { name }),
    ...(changes.role && { role }),
    ...(changes.profile && { profileAccessId }),
    ...(changes.driver && { driverId }),
  };

  return {
    ok: true,
    next: { role, email, name, businessId, profileAccessId, driverId },
    changes,
    data,
    changed: Object.values(changes).some(Boolean),
    endsSessions: changes.role || changes.driver,
  };
}

/** The changed fields as the audit trail names them. */
const CHANGE_LABELS: Record<keyof UserUpdateChanges, string> = {
  name: "nome",
  email: "e-mail",
  role: "nível de acesso",
  profile: "perfil de acesso",
  driver: "motorista vinculado",
};

function describeChanges(changes: UserUpdateChanges): string {
  return (Object.keys(CHANGE_LABELS) as (keyof UserUpdateChanges)[])
    .filter((key) => changes[key])
    .map((key) => CHANGE_LABELS[key])
    .join(", ");
}

export { describeChanges, planUserUpdate };
export type {
  UserSnapshot,
  UserUpdateChanges,
  UserUpdateData,
  UserUpdateInput,
  UserUpdatePlan,
  UserUpdatePlanError,
};
