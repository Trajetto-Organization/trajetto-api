import { Prisma } from "@prisma/client";

import {
  deleteInBatches,
  type BatchDeleteClient,
  type BatchDeleteResult,
} from "@/shared/database/batch-delete";

/**
 * The session revocation log (plano-escala F5-21): the triggers that write
 * it, and the columns of the session check each one covers.
 *
 * ensureAuthenticated, the socket's handshake and its sweep read the user
 * with its company, profile and driver, and the refresh-token family
 * (SessionRepository.loadSession, session-eligibility.ts,
 * socket-revalidation.ts). A change to any of those columns can end a
 * session or narrow what it may do, and was seen only when the session was
 * read again. The triggers (prisma/migrations/20261119160*) write
 * (kind, subject_id) into session_revocation_log in the writer's
 * transaction, and the revocation feed (F5-22) hands it to the sockets and
 * the session cache within a second.
 *
 * This list is the contract: tests/E2E/session-revocation-triggers.test.ts
 * holds the database's triggers to it, case by case, and
 * tests/unitaires/auth/session-revocation-coverage.test.ts fails when the
 * session check reads a column no trigger covers. A new check on a new
 * column comes with its trigger, or a cached session (F5-23) and a socket
 * keep the rights they had until the next read.
 */

const SESSION_REVOCATION_KINDS = [
  "user",
  "business",
  "branch",
  "driver",
  "profile",
  "refresh_family",
] as const;

type SessionRevocationKind = (typeof SESSION_REVOCATION_KINDS)[number];

interface RevocationTrigger {
  name: string;
  table: string;
  event: "INSERT" | "UPDATE" | "DELETE";
  /** UPDATE OF these columns, fired only when one of them changed. */
  columns?: readonly string[];
  kind: SessionRevocationKind;
  /** The column that names the subject (the old and the new value). */
  subject: string;
}

const SESSION_REVOCATION_TRIGGERS: readonly RevocationTrigger[] = [
  {
    name: "user_session_revocation",
    table: "user",
    event: "UPDATE",
    columns: [
      "password",
      "access_revoked",
      "role",
      "session_version",
      "businessId",
      "driverId",
      "profileAccessId",
      "anonymized_at",
    ],
    kind: "user",
    subject: "id",
  },
  {
    name: "user_delete_session_revocation",
    table: "user",
    event: "DELETE",
    kind: "user",
    subject: "id",
  },
  // A family's live token deleted, or revoked without a successor. The
  // rotation (revoked_at with replaced_by_jti) and the purge of what was
  // already revoked or expired write nothing: the triggers' WHEN.
  {
    name: "refresh_token_delete_session_revocation",
    table: "refresh_token",
    event: "DELETE",
    kind: "refresh_family",
    subject: "family_id",
  },
  {
    name: "refresh_token_revoke_session_revocation",
    table: "refresh_token",
    event: "UPDATE",
    columns: ["revoked_at"],
    kind: "refresh_family",
    subject: "family_id",
  },
  {
    name: "business_session_revocation",
    table: "business",
    event: "UPDATE",
    columns: ["is_active"],
    kind: "business",
    subject: "id",
  },
  {
    name: "business_delete_session_revocation",
    table: "business",
    event: "DELETE",
    kind: "business",
    subject: "id",
  },
  {
    name: "business_entitlement_insert_session_revocation",
    table: "business_entitlement",
    event: "INSERT",
    kind: "business",
    subject: "businessId",
  },
  {
    name: "business_entitlement_session_revocation",
    table: "business_entitlement",
    event: "UPDATE",
    columns: ["enabled", "module", "businessId"],
    kind: "business",
    subject: "businessId",
  },
  {
    name: "business_entitlement_delete_session_revocation",
    table: "business_entitlement",
    event: "DELETE",
    kind: "business",
    subject: "businessId",
  },
  {
    name: "driver_session_revocation",
    table: "driver",
    event: "UPDATE",
    columns: ["status", "businessId", "branchId"],
    kind: "driver",
    subject: "id",
  },
  {
    name: "driver_delete_session_revocation",
    table: "driver",
    event: "DELETE",
    kind: "driver",
    subject: "id",
  },
  {
    name: "branch_session_revocation",
    table: "branch",
    event: "UPDATE",
    columns: ["is_active"],
    kind: "branch",
    subject: "id",
  },
  {
    name: "branch_delete_session_revocation",
    table: "branch",
    event: "DELETE",
    kind: "branch",
    subject: "id",
  },
  {
    name: "permission_insert_session_revocation",
    table: "permission",
    event: "INSERT",
    kind: "profile",
    subject: "profileAccessId",
  },
  {
    name: "permission_session_revocation",
    table: "permission",
    event: "UPDATE",
    columns: [
      "permissionKey",
      "action",
      "canRead",
      "canWrite",
      "profileAccessId",
    ],
    kind: "profile",
    subject: "profileAccessId",
  },
  {
    name: "permission_delete_session_revocation",
    table: "permission",
    event: "DELETE",
    kind: "profile",
    subject: "profileAccessId",
  },
  {
    name: "profile_access_delete_session_revocation",
    table: "profile_access",
    event: "DELETE",
    kind: "profile",
    subject: "id",
  },
];

/**
 * Every field the session check reads, as `<object>.<field>` in the code
 * that reads it, with the table column whose change is logged. A relation
 * the check reads through (the user's company, profile and driver) names
 * the columns of that row instead.
 */
const SESSION_CHECK_COVERAGE: Readonly<Record<string, readonly string[]>> = {
  "user.session_version": ["user.session_version"],
  "user.access_revoked": ["user.access_revoked"],
  "user.role": ["user.role"],
  "user.businessId": ["user.businessId"],
  "user.driverId": ["user.driverId"],
  // The profile's id: the subject the session cache (F5-23) drops a
  // manager's session by when the profile's permissions change.
  "user.profileAccessId": ["user.profileAccessId"],
  "user.profileAccess": [
    "user.profileAccessId",
    "permission.permissionKey",
    "permission.action",
    "permission.canRead",
    "permission.canWrite",
    "permission.profileAccessId",
  ],
  "user.business": ["business.is_active", "business_entitlement.enabled"],
  "user.driver": ["driver.status", "driver.businessId", "driver.branchId"],
  "driverRecord.status": ["driver.status"],
  "driverRecord.businessId": ["driver.businessId"],
  "driverRecord.branch": ["branch.is_active"],
  "driverRecord.id": [],
  "driverRecord.branchId": ["driver.branchId"],
  // The family: hasActiveFamily, from refresh_token.
  familyActive: ["refresh_token.revoked_at"],
  // Not a revocation: who the user is, read for the log and the rooms.
  "user.id": [],
};

/** The table columns some trigger covers, as `<table>.<column>`. */
function coveredColumns(): Set<string> {
  return new Set(
    SESSION_REVOCATION_TRIGGERS.flatMap((trigger) =>
      (trigger.columns ?? []).map((column) => `${trigger.table}.${column}`),
    ),
  );
}

/** How long a row is kept: a process that missed more has nothing to revoke. */
const SESSION_REVOCATION_RETENTION_DAYS = 7;

/**
 * The nightly purge of the log, oldest first, in batches (the refresh-token
 * purge runs it on the maintenance pool).
 */
function purgeSessionRevocationLog(
  client: BatchDeleteClient,
  {
    now = new Date(),
    deadline = Number.POSITIVE_INFINITY,
    maxRows = 200_000,
  }: { now?: Date; deadline?: number; maxRows?: number } = {},
): Promise<BatchDeleteResult> {
  const before = new Date(
    now.getTime() - SESSION_REVOCATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  return deleteInBatches({
    table: Prisma.sql`"session_revocation_log"`,
    where: Prisma.sql`"at" < ${before}`,
    orderBy: Prisma.sql`"at"`,
    maxRows,
    deadline,
    client,
  });
}

export {
  SESSION_CHECK_COVERAGE,
  SESSION_REVOCATION_KINDS,
  SESSION_REVOCATION_RETENTION_DAYS,
  SESSION_REVOCATION_TRIGGERS,
  coveredColumns,
  purgeSessionRevocationLog,
};
export type { RevocationTrigger, SessionRevocationKind };
