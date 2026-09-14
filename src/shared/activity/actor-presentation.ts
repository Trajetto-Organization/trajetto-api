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
 * untouched for MASTER, whose whole job here is auditing who did what.
 *
 * Masking happens on the server on purpose: doing it in the component would
 * still ship the e-mail to the browser, where anyone can read it.
 */

/** Distinct from the real roles so a filter can offer it as its own option. */
const PLATFORM_ROLE = "PLATFORM";
const PLATFORM_ACTOR_NAME = "Suporte Trajetto";

interface ActivityActor {
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

interface ActivityWithActor {
  user?: ActivityActor | null;
}

function presentActivityActor<T extends ActivityWithActor>(
  activity: T,
  viewerRole: string | undefined,
): T {
  // The back office audits with real identities.
  if (viewerRole === "MASTER") return activity;

  // Everything else in a company log was authored inside that company.
  if (activity.user?.role !== "MASTER") return activity;

  return {
    ...activity,
    user: {
      ...activity.user,
      name: PLATFORM_ACTOR_NAME,
      email: null,
      role: PLATFORM_ROLE,
    },
  };
}

function presentActivityActors<T extends ActivityWithActor>(
  activities: T[],
  viewerRole: string | undefined,
): T[] {
  if (viewerRole === "MASTER") return activities;

  return activities.map((activity) =>
    presentActivityActor(activity, viewerRole),
  );
}

export {
  presentActivityActor,
  presentActivityActors,
  PLATFORM_ROLE,
  PLATFORM_ACTOR_NAME,
};
