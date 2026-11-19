/**
 * What a company's purge deletes, and in which order (plano-escala F3-26a).
 *
 * The TENANT_OFFBOARD job walks these steps top to bottom, each in batches
 * of short transactions on the maintenance pool (purge-batch.ts). The order
 * is the foreign keys': a row goes before the row it points at, so no batch
 * ever meets a RESTRICT (a fine still pointing at its driver, a delivery at
 * its shipper) and none sets off a cascade of unknown size. A CASCADE child
 * with a handful of rows per parent may ride its parent's batch (`cascades`
 * names it); every other child has its own step.
 *
 * tests/unitaires/jobs/tenant-purge-plan.test.ts reads prisma/schema.prisma
 * and fails when a table that holds a company's rows is missing here, or
 * when a child comes after its parent; tests/E2E/tenant-offboard.test.ts
 * checks the same against the database's own catalog and purges a company
 * seeded with a row of every kind.
 *
 * The kinds of step:
 *
 *  - direct: the rows whose `column` is the company, through that column's
 *    index;
 *  - children: the rows of a table without the company's column, found by
 *    the keys of their parent, a page of parents at a time (keyset on the
 *    parent's id, the cursor of the step). Probing every parent again on
 *    every batch would read the parents already done once per batch;
 *  - scan: the rows of a small table without an index by company (the dead
 *    letters), by a walk of its primary key in chunks;
 *  - expires: rows the purge does not delete, said with what takes them:
 *    a queue without an index by company (a scan would read the whole
 *    queue on every purge) whose rows leave by the queue's own retention,
 *    and the GPS trail, which leaves by the DROP of its daily partitions
 *    unless TENANT_PURGE_TRAIL_NOW deletes it now (`trail` steps).
 */

/** Rows of another table hanging off the deleted keys without a key. */
interface PurgeDependent {
  table: string;

  /** The dependent's column that holds the deleted row's value. */
  column: string;

  /** The deleted row's column it holds; the step's key by default. */
  from?: string;
}

interface PurgeStepBase {
  /** The table the step deletes from, by its SQL name. */
  table: string;

  /** The columns a batch picks rows by: the primary key. */
  key?: readonly string[];

  /**
   * Deleted in the same statement, by the values the step's DELETE
   * returned: the queues' rows that lost their foreign keys (F5-06).
   */
  dependents?: readonly PurgeDependent[];

  /**
   * Tables that leave by this step's ON DELETE CASCADE, a few rows per row
   * (an analysis' units and their attempts).
   */
  cascades?: readonly string[];

  /** A table that may not exist (the shell of a copy window, F2-17). */
  optional?: boolean;

  /** The GPS trail: deleted only with TENANT_PURGE_TRAIL_NOW. */
  trail?: boolean;
}

interface DirectStep extends PurgeStepBase {
  kind: "direct";

  /** The table's column that holds the company. */
  column: string;

  /** Another condition, constant SQL on the table's own columns. */
  where?: string;
}

interface ChildrenStep extends PurgeStepBase {
  kind: "children";

  /** The child's column that holds the parent's value. */
  column: string;

  /** The parent table, which holds the company in `parentColumn`. */
  parent: string;

  /** The parent's column whose value the child holds; `id` by default. */
  parentKey?: string;

  /** The parent's column that holds the company; `businessId` by default. */
  parentColumn?: string;

  /** The SQL type of the child's column when it is not text. */
  cast?: "uuid";
}

interface ScanStep extends PurgeStepBase {
  kind: "scan";

  /** The table's column that holds the company. */
  column: string;
}

interface ExpiresStep {
  kind: "expires";
  table: string;

  /** The table's column that holds the company. */
  column: string;

  /** What removes the rows the purge leaves (pt-BR, for the docs). */
  by: string;
}

type DeletingStep = DirectStep | ChildrenStep | ScanStep;
type PurgeStep = DeletingStep | ExpiresStep;

/** Tables the plan leaves to another phase of the job, with why. */
const HANDLED_ELSEWHERE: Readonly<Record<string, string>> = {
  // The purge's own row: the last phase deletes the company's other jobs,
  // and this one leaves with BACKGROUND_JOB_SUCCEEDED_RETENTION_DAYS.
  background_job: "finish",
  // Its objects and rows go together (deleteTrailArchive).
  archive_manifest: "trail-archive",
  // Kept as the tombstone PURGED, or removed last (the old "Deletar").
  business: "finish",
};

const USER = "user";

const TENANT_PURGE_PLAN: readonly PurgeStep[] = [
  // The queues and logs: nothing points at them.
  { kind: "direct", table: "webhook_delivery", column: "businessId" },
  {
    kind: "children",
    table: "notification_delivery",
    column: "userId",
    parent: USER,
    dependents: [
      { table: "notification_provider_receipt", column: "deliveryId" },
    ],
  },
  {
    kind: "children",
    table: "notification_delivery",
    column: "externalRecipientId",
    parent: "external_recipient",
    dependents: [
      { table: "notification_provider_receipt", column: "deliveryId" },
    ],
  },
  { kind: "children", table: "notification", column: "userId", parent: USER },
  { kind: "scan", table: "notification_dead_letter", column: "businessId" },
  { kind: "scan", table: "outbox_event_dead_letter", column: "businessId" },
  {
    // The live events, through the fair claim's partial index; the
    // published ones leave with their retention (below).
    kind: "direct",
    table: "domain_outbox_event",
    column: "businessId",
    where: `"status" IN ('PENDING', 'PROCESSING')`,
    dependents: [
      { table: "outbox_event_key", column: "event_key", from: "eventKey" },
    ],
  },
  {
    kind: "expires",
    table: "domain_outbox_event",
    column: "businessId",
    by: "a retenção dos eventos publicados (OUTBOX_PUBLISHED_RETENTION_DAYS, 30 dias); a empresa já está inativa há esse tempo",
  },
  {
    kind: "expires",
    table: "delivery_event_submission",
    column: "businessId",
    by: "a retenção das chaves de envio (DELIVERY_EVENT_SUBMISSION_RETENTION_DAYS)",
  },
  {
    kind: "expires",
    table: "notification",
    column: "businessId",
    by: "a retenção do sino (NOTIFICATION_UNREAD_RETENTION_DAYS): só os avisos de usuários da plataforma sobre a empresa; os dos usuários dela saem acima",
  },

  // The GPS trail: by the DROP of its days, or now with
  // TENANT_PURGE_TRAIL_NOW, before the drivers it is read by.
  {
    kind: "direct",
    table: "driver_position",
    column: "businessId",
    key: ["id", "recorded_at"],
    trail: true,
  },
  {
    // No index by company (F2-10): driver by driver, by the primary key.
    kind: "children",
    table: "driver_position_v2",
    column: "driverId",
    parent: "driver",
    cast: "uuid",
    key: ["driverId", "recorded_at"],
    trail: true,
  },
  {
    // The drivers a restore of the archived trail leaves out (F3-27): the
    // company's archive goes whole in the trail-archive phase.
    kind: "direct",
    table: "trail_archive_redaction",
    column: "businessId",
    key: ["driverId"],
  },
  {
    kind: "expires",
    table: "driver_position",
    column: "businessId",
    by: "o DROP da partição do dia (DRIVER_POSITION_RETENTION_DAYS), sem TENANT_PURGE_TRAIL_NOW",
  },
  {
    kind: "expires",
    table: "driver_position_v2",
    column: "businessId",
    by: "o DROP da partição do dia (DRIVER_POSITION_RETENTION_DAYS), sem TENANT_PURGE_TRAIL_NOW",
  },

  // Chat and support.
  {
    kind: "children",
    table: "support_ticket_read",
    column: "ticketId",
    parent: "support_ticket",
  },
  {
    kind: "children",
    table: "chat_thread_read",
    column: "threadId",
    parent: "chat_thread",
  },
  {
    kind: "children",
    table: "chat_message",
    column: "threadId",
    parent: "chat_thread",
  },
  { kind: "direct", table: "support_ticket_event", column: "businessId" },
  { kind: "direct", table: "support_ticket", column: "businessId" },
  {
    kind: "direct",
    table: "support_ticket_counter",
    column: "businessId",
    key: ["businessId"],
  },
  { kind: "direct", table: "chat_thread", column: "businessId" },

  // The deliveries' history, then what hangs off a delivery or a route.
  { kind: "direct", table: "delivery_event", column: "businessId" },
  {
    kind: "direct",
    table: "delivery_event_part",
    column: "businessId",
    optional: true,
  },
  { kind: "direct", table: "delivery_occurrence", column: "businessId" },
  { kind: "direct", table: "delivery_proof_audit", column: "businessId" },
  { kind: "direct", table: "delivery_proof_document", column: "businessId" },
  { kind: "direct", table: "external_recipient", column: "businessId" },
  {
    kind: "children",
    table: "delivery_item",
    column: "deliveryId",
    parent: "delivery",
  },
  {
    kind: "children",
    table: "route_stop",
    column: "routeId",
    parent: "route",
  },
  { kind: "direct", table: "activity", column: "businessId" },
  {
    kind: "direct",
    table: "activity_part",
    column: "businessId",
    optional: true,
  },

  // The fleet's records: each holds its driver and vehicle by RESTRICT
  // (driver_pause before the driver, schema.prisma's DriverPause).
  { kind: "direct", table: "fuel", column: "businessId" },
  { kind: "direct", table: "vehicle_checklist", column: "businessId" },
  { kind: "direct", table: "fine", column: "businessId" },
  { kind: "direct", table: "driver_pause", column: "businessId" },
  { kind: "direct", table: "account_payable", column: "businessId" },
  { kind: "direct", table: "service_order_part", column: "businessId" },
  { kind: "direct", table: "service_order", column: "businessId" },
  { kind: "direct", table: "part", column: "businessId" },
  { kind: "direct", table: "supplier", column: "businessId" },
  {
    kind: "children",
    table: "kanban_card",
    column: "columnId",
    parent: "kanban_column",
  },
  { kind: "direct", table: "kanban_column", column: "businessId" },

  // The deliveries and routes themselves, then what they pointed at.
  { kind: "direct", table: "delivery", column: "businessId" },
  { kind: "direct", table: "route", column: "businessId" },
  { kind: "direct", table: "import", column: "businessId" },
  { kind: "direct", table: "shipper", column: "businessId" },
  { kind: "direct", table: "occurrence_type", column: "businessId" },
  { kind: "direct", table: "status_change_reason", column: "businessId" },
  {
    kind: "direct",
    table: "customer_message_suppression",
    column: "businessId",
  },
  { kind: "direct", table: "delivery_message_template", column: "businessId" },

  // The integration.
  { kind: "direct", table: "webhook_endpoint", column: "businessId" },
  { kind: "direct", table: "api_key_usage_daily", column: "businessId" },
  { kind: "direct", table: "api_key", column: "businessId" },

  // The AI's ledger: a request's units and their attempts ride its batch.
  {
    kind: "direct",
    table: "ai_analysis_request",
    column: "businessId",
    cascades: ["ai_analysis_unit", "ai_provider_attempt"],
  },
  { kind: "direct", table: "ai_usage_period", column: "businessId" },

  // The fleet's registers.
  {
    kind: "direct",
    table: "driver_last_position",
    column: "businessId",
    key: ["driverId"],
  },
  {
    kind: "direct",
    table: "driver_enrollment_token",
    column: "businessId",
  },
  { kind: "direct", table: "vehicle", column: "businessId" },
  { kind: "direct", table: "fuel_type", column: "businessId" },
  { kind: "direct", table: "vehicle_type", column: "businessId" },

  // The people: their sessions and tokens, then the logins, then the
  // drivers (a login points at its driver).
  {
    kind: "children",
    table: "refresh_token",
    column: "userId",
    parent: USER,
  },
  {
    kind: "children",
    table: "push_device_token",
    column: "userId",
    parent: USER,
  },
  {
    kind: "children",
    table: "two_factor_confirmation",
    column: "userId",
    parent: USER,
  },
  {
    kind: "children",
    table: "driver_trusted_device",
    column: "userId",
    parent: USER,
  },
  {
    kind: "children",
    table: "notification_preference",
    column: "userId",
    parent: USER,
  },
  {
    kind: "children",
    table: "pending_deletion",
    column: "userId",
    parent: USER,
  },
  {
    // The MASTER's own request to delete the company, if one is left.
    kind: "direct",
    table: "pending_deletion",
    column: "entity_id",
    where: `"entity_type" = 'business'`,
  },
  {
    kind: "children",
    table: "email_verification_token",
    column: "email",
    parent: USER,
    parentKey: "email",
  },
  {
    kind: "children",
    table: "forgot_password_verification_token",
    column: "email",
    parent: USER,
    parentKey: "email",
  },
  {
    kind: "children",
    table: "two_factor_token",
    column: "email",
    parent: USER,
    parentKey: "email",
  },
  { kind: "direct", table: "business_settings", column: "businessId" },
  { kind: "direct", table: USER, column: "businessId" },
  { kind: "direct", table: "driver", column: "businessId" },
  { kind: "direct", table: "permission", column: "businessId" },
  { kind: "direct", table: "profile_access", column: "businessId" },
  { kind: "direct", table: "branch", column: "businessId" },
  { kind: "direct", table: "business_entitlement", column: "businessId" },

  // The dashboard's days (plano-escala F4-20), last of all. Every DELETE
  // of a delivery above wrote its day into tenant_day_dirty by trigger, and
  // that table has no key to the company: before the deliveries' step it
  // would keep the rows of the batches after it. Appended at the end, so a
  // purge stopped half-way by the image of before resumes with every step
  // number of that image still meaning the same table.
  {
    kind: "direct",
    table: "tenant_day_count",
    column: "businessId",
    key: ["businessId", "metric", "day"],
  },
  { kind: "direct", table: "tenant_day_dirty", column: "businessId" },
];

function isDeletingStep(step: PurgeStep): step is DeletingStep {
  return step.kind !== "expires";
}

export { HANDLED_ELSEWHERE, TENANT_PURGE_PLAN, isDeletingStep };
export type {
  ChildrenStep,
  DeletingStep,
  DirectStep,
  ExpiresStep,
  PurgeDependent,
  PurgeStep,
  ScanStep,
};
