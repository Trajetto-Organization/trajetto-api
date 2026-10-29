/**
 * How an activity's author is presented to whoever is reading the log.
 *
 * Plan changes are the one MASTER action a company can see (TENANT_VISIBLE),
 * and showing them raised a question the audit trail had never faced: the row
 * carried the operator's real name and personal e-mail into a customer's
 * screen. The customer does need to know the change came from Trajetto rather
 * than from someone inside their own company — that distinction is the useful
 * part. Which particular employee clicked it is not, and a personal address is
 * not ours to hand out.
 *
 * So the identity is collapsed to the platform for outside readers, and left
 * untouched for MASTER, whose whole job here is auditing who did what. The
 * row's own copies of it go too: `performedBy` is the operator's user id and
 * `performingUserRole` says "MASTER", and the list search does not match a
 * platform row by them (activity-repository), or the search box would confirm
 * a guessed e-mail the presentation hides.
 *
 * A driver acting from the app is a BUSINESS_USER linked to a driver record,
 * and appeared as "Colaborador" (FLEET-ACT-7). The row is presented with the
 * DRIVER pseudo-role instead, for every reader; the link itself (`driverId`)
 * is read only to decide that and never leaves the server.
 *
 * Masking happens on the server on purpose: doing it in the component would
 * still ship the e-mail to the browser, where anyone can read it.
 */

/** Distinct from the real roles so a filter can offer it as its own option. */
const PLATFORM_ROLE = "PLATFORM";
const PLATFORM_ACTOR_NAME = "Suporte Trajetto";

/** A BUSINESS_USER acting as a driver (the mobile app's actions). */
const DRIVER_ROLE = "DRIVER";

interface ActivityActor {
  name?: string | null;
  email?: string | null;
  role?: string | null;
  driverId?: string | null;
}

interface ActivityWithActor {
  user?: ActivityActor | null;
  performedBy?: string | null;
  performingUserRole?: string | null;
}

function presentActivityActor<T extends ActivityWithActor>(
  activity: T,
  viewerRole: string | undefined,
): T {
  if (!activity.user) return activity;

  const { driverId, ...actor } = activity.user;

  // Everything else in a company log was authored inside that company; the
  // back office audits with real identities.
  if (actor.role === "MASTER" && viewerRole !== "MASTER") {
    return {
      ...activity,
      ...("performedBy" in activity && { performedBy: null }),
      ...("performingUserRole" in activity && { performingUserRole: null }),
      user: {
        ...actor,
        name: PLATFORM_ACTOR_NAME,
        email: null,
        role: PLATFORM_ROLE,
      },
    };
  }

  if (driverId && actor.role === "BUSINESS_USER") {
    return { ...activity, user: { ...actor, role: DRIVER_ROLE } };
  }

  // No link was read (or there is none): the row as it came.
  if (driverId === undefined) return activity;

  return { ...activity, user: actor };
}

function presentActivityActors<T extends ActivityWithActor>(
  activities: T[],
  viewerRole: string | undefined,
): T[] {
  return activities.map((activity) =>
    presentActivityActor(activity, viewerRole),
  );
}

export {
  presentActivityActor,
  presentActivityActors,
  DRIVER_ROLE,
  PLATFORM_ROLE,
  PLATFORM_ACTOR_NAME,
};
