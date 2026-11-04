import type { Branch } from "@/modules/branch/dtos/branch-dto";
import type { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { RouteRecordBranchMissingPayload } from "@/shared/notifications/notification-types";

const log = logger.child({ component: "record-branch" });

/**
 * The branch a fleet record made in the field is filed under: a checklist or
 * a refuelling (finding of the closing review, 03/11/2026).
 *
 * Branch is optional on the vehicle and on the driver, yet both records
 * require one. They used to take the vehicle's, else the driver's, and
 * refuse with 400 BRANCH_REQUIRED otherwise — a refusal the app treats as
 * permanent, so a driver whose company asks for the departure checklist
 * could never start the route, stuck on a field an admin left blank. The
 * company's single ACTIVE branch closes most of that gap: a carrier with one
 * branch (the common case) has only one answer. With no active branch, or
 * several, nothing is guessed and the caller still refuses; the route
 * release tells the dispatcher before the driver gets there
 * (ROUTE_BRANCH_REQUIRED, modules/route/usecases/shared/route-branch-guard).
 *
 * The lookup of the company's branches is lazy: a record whose vehicle or
 * driver names a branch never queries for it.
 *
 * This plain resolution is the manager's (who left the branch blank in the
 * form, and is told BRANCH_INACTIVE when the vehicle's branch is switched
 * off: the person who can fix it is the one asking). A driver's record goes
 * through `resolveActiveRecordBranchId` below.
 */
interface RecordBranchSources {
  vehicleBranchId?: string | null;
  driverBranchId?: string | null;
}

async function resolveRecordBranchId(
  sources: RecordBranchSources,
  soleActiveBranchId: () => Promise<string | null>,
): Promise<string | null> {
  return (
    sources.vehicleBranchId ||
    sources.driverBranchId ||
    (await soleActiveBranchId()) ||
    null
  );
}

/** What resolving through ACTIVE branches only asks of the company. */
interface ActiveBranchLookups {
  /** Whether the id is an ACTIVE branch of the company; another's never is. */
  isActiveBranch: (branchId: string) => Promise<boolean>;
  soleActiveBranchId: () => Promise<string | null>;
}

/**
 * A driver's record is filed under an ACTIVE branch only (wave 3.7; the
 * product principle: never hold the driver over an admin-side data gap,
 * show it to the dispatcher).
 *
 * The release checks the route's checklist can be filed, but the branches
 * can change under a released route: the vehicle's switched off, or its
 * branch cleared while a second active one appears. The checklist used to
 * take the vehicle's branch as it was and refuse it (BRANCH_INACTIVE), and
 * the app kept the driver's checklist refused in its queue. An inactive
 * branch is closed for new records (it may be on its way to deletion, which
 * cascades to them), so the record is not filed there: it falls through to
 * the driver's branch, then to the company's single active one — the same
 * order, skipping what is switched off. Only when none of them is an active
 * branch of this company does the caller refuse, and tell the dispatcher
 * (`announceRecordBranchGap`).
 */
async function resolveActiveRecordBranchId(
  sources: RecordBranchSources,
  lookups: ActiveBranchLookups,
): Promise<string | null> {
  for (const candidate of [sources.vehicleBranchId, sources.driverBranchId]) {
    if (candidate && (await lookups.isActiveBranch(candidate))) {
      return candidate;
    }
  }

  return (await lookups.soleActiveBranchId()) || null;
}

/**
 * The lookups over a branch repository, inside one company. A row read once
 * is kept for the caller's next question (the guard names the inactive
 * branch it skipped), so no branch is read twice.
 */
function activeBranchLookups(
  branches: Pick<
    IBranchRepository,
    "findBranchById" | "findSoleActiveBranchId"
  >,
  businessId: string,
): ActiveBranchLookups & {
  rowOf: (branchId: string) => Promise<Branch | null>;
} {
  const rows = new Map<string, Promise<Branch | null>>();

  const rowOf = (branchId: string): Promise<Branch | null> => {
    let row = rows.get(branchId);

    if (!row) {
      row = branches
        .findBranchById(branchId)
        // Another company's branch reads as no branch at all.
        .then((found) => (found?.businessId === businessId ? found : null));
      rows.set(branchId, row);
    }

    return row;
  };

  return {
    rowOf,
    isActiveBranch: async (branchId) => {
      const row = await rowOf(branchId);

      // The column defaults to true, as the twin reads it.
      return row !== null && row.is_active !== false;
    },
    soleActiveBranchId: () => branches.findSoleActiveBranchId(businessId),
  };
}

type RecordKind = RouteRecordBranchMissingPayload["record"];

/**
 * A driver's record with no active branch to file it under: 409, a conflict
 * with the company's records rather than with the body — the same family as
 * BRANCH_INACTIVE and ROUTE_BRANCH_REQUIRED. The manager's blank field keeps
 * its 400. The app reads the code, not the status, and offers "Tentar de
 * novo" once the branch is fixed.
 */
function driverRecordBranchRequired(record: RecordKind): AppError {
  const what = record === "CHECKLIST" ? "o checklist" : "o abastecimento";

  return new AppError(
    `Não há filial ativa para registrar ${what}: o gestor precisa definir uma filial ativa no veículo ou no motorista.`,
    409,
    "BRANCH_REQUIRED",
  );
}

interface RecordBranchGap {
  route: { id: string; code: number };
  businessId: string;
  /** The driver's user: the trail entry is theirs. */
  actorId: string;
  record: RecordKind;
  phase: RouteRecordBranchMissingPayload["phase"];
  driverName: string | null;
  vehiclePlate: string;
}

/**
 * Tells the people who run the deliveries that a driver's route record was
 * refused for want of an active branch (`route.record_branch_missing`: their
 * inbox and the route's trail).
 *
 * Once per route and moment — the departure checklist, the arrival one, the
 * route's refuellings — whatever the retries: the event key is unique and
 * the insert skips a key already there, so the app's resends and two
 * replicas answering them at once write one event. Outside any transaction:
 * nothing else is written, the refusal itself is the outcome. Best-effort
 * for the request: a notice that cannot be written is logged and the driver
 * still gets the refusal; the next resend tries the notice again.
 */
async function announceRecordBranchGap(
  outbox: Pick<OutboxService, "publishOnce">,
  gap: RecordBranchGap,
): Promise<void> {
  const slot = gap.phase ?? gap.record;

  try {
    await outbox.publishOnce({
      topic: "route.record_branch_missing",
      aggregateType: "route",
      aggregateId: gap.route.id,
      businessId: gap.businessId,
      actorId: gap.actorId,
      eventKey: `route.record_branch_missing:${gap.route.id}:${slot}`,
      payload: {
        routeId: gap.route.id,
        businessId: gap.businessId,
        code: gap.route.code,
        record: gap.record,
        phase: gap.phase,
        driverName: gap.driverName,
        vehiclePlate: gap.vehiclePlate,
      },
    });
  } catch (err) {
    log.error(
      { err, routeId: gap.route.id, businessId: gap.businessId, slot },
      "the dispatcher could not be told of a record with no active branch",
    );
  }
}

export {
  activeBranchLookups,
  announceRecordBranchGap,
  driverRecordBranchRequired,
  resolveActiveRecordBranchId,
  resolveRecordBranchId,
};
export type { ActiveBranchLookups, RecordBranchGap, RecordBranchSources };
