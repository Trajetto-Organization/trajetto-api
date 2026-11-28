/**
 * What this build can run alongside, announced in every ops_sample row
 * (plano-escala F5-07, D20).
 *
 * A contraction (a constraint dropped, a table swapped for a partitioned
 * one, an index the old code needed) cannot run while an image that still
 * leans on what it removes is serving: during a rolling deploy, or after a
 * rollback. So it does not ride the migrations. It is a step of
 * prisma/post-deploy that waits, 'pending', until every live process
 * announces the capability it needs (trajetto_capability_ready, in
 * prisma/post-deploy/00-queue-swap-ready.sql), and the release step runs it
 * again on the next deploy or on a force_release.
 *
 * A capability is a promise about the code, never about the data: an image
 * announces one only when nothing it runs needs what the matching step
 * takes away. Never removed from a build that keeps the promise; a name is
 * never reused for another promise (the `-vN` grows instead).
 *
 *  - queue-partition-agnostic-v1: nothing writes or reads the four queues
 *    (domain_outbox_event, notification_delivery,
 *    notification_provider_receipt, webhook_delivery) through a foreign
 *    key, a cascade or a unique other than the primary key. The keys live
 *    in outbox_event_key, the deliveries' and receipts' ids are decided by
 *    the fact, every deletion takes its own queue rows (wave 8: F5-02 to
 *    F5-05), and every id written there is a uuid v7
 *    (tests/unitaires/database/queue-ids-v7-guard.test.ts). What the
 *    contraction of F5-06 and the swap of F5-09 need.
 *  - route-stop-open-by-route-v1: "not on an open stop" looks for the stop
 *    through the company's open routes (F2-21), never through the global
 *    route_stop ("status", "deliveryId") index that F2-21b drops.
 *  - notification-partition-agnostic-v1: nothing writes or reads the bell
 *    (notification) through its foreign keys, their cascades or the unique
 *    on deliveryId. A notification's id is its delivery's, so a retried
 *    IN_APP meets the primary key (F5-14), and deleting a user or a company
 *    takes its bell rows in SQL (queue-row-cleanup.ts). What the
 *    contraction and the monthly swap of F5-15 need.
 *  - history-partition-agnostic-v1: nothing writes or reads the history
 *    (delivery_event, activity) through a unique other than the primary
 *    key. A driver's submission key is claimed in delivery_event_submission
 *    in the same transaction as its event, and the replay looks there and
 *    on the column (F2-14); an activity of the notification pipeline is
 *    written under its delivery's id and found by it, or by deliveryId
 *    (F2-15); every id written there is a uuid v7 (the models' default, or
 *    a delivery's id). What the copy windows of F2-17 and F2-18 need: the
 *    partitioned tables keep neither the unique of client_submission_id
 *    nor that of activity.deliveryId.
 */
const PROCESS_CAPABILITIES = [
  "queue-partition-agnostic-v1",
  "route-stop-open-by-route-v1",
  "notification-partition-agnostic-v1",
  "history-partition-agnostic-v1",
] as const;

type ProcessCapability = (typeof PROCESS_CAPABILITIES)[number];

export { PROCESS_CAPABILITIES, type ProcessCapability };
