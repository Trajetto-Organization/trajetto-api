/**
 * Which generation of activity ids the trail serves (plano-escala F2-18),
 * sent on the timeline feed as `x-trajetto-data-version`.
 *
 * The copy window of the activity trail
 * (prisma/post-deploy/31-activity-window.sql) gives every row from before
 * the switch to uuid v7 a new id. A tab open across that night holds rows
 * and a cursor under the old ids: its next "carregar mais" would come back
 * empty, or with rows it already shows under new ids, which the web's
 * de-duplication by id (trajetto-ui features/activity/timeline-feed) cannot
 * catch. So the feed says which generation it read, and the web drops the
 * feed it holds when the answer changes and reads it again from the top.
 *
 *  - "1": activity is the plain table, the ids as they were written;
 *  - "2": activity is the partitioned table of the window, every id a v7.
 *
 * A way back (rollback/unpartition-activity.sql) brings "1" back, and the
 * web drops its feed again. Read from the catalog, which is the fact.
 */
const ACTIVITY_DATA_VERSION_HEADER = "x-trajetto-data-version";

const ACTIVITY_DATA_VERSIONS = {
  original: "1",
  rekeyed: "2",
} as const;

type ActivityDataVersion =
  (typeof ACTIVITY_DATA_VERSIONS)[keyof typeof ACTIVITY_DATA_VERSIONS];

/** The generation of a trail whose table is (or is not) partitioned. */
function activityDataVersion(partitioned: boolean): ActivityDataVersion {
  return partitioned
    ? ACTIVITY_DATA_VERSIONS.rekeyed
    : ACTIVITY_DATA_VERSIONS.original;
}

export {
  ACTIVITY_DATA_VERSION_HEADER,
  ACTIVITY_DATA_VERSIONS,
  activityDataVersion,
  type ActivityDataVersion,
};
