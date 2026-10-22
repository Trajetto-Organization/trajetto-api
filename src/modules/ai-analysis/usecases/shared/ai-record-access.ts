import { FastifyReply, FastifyRequest } from "fastify";

import database from "@/../infra/database";

import { PermissionKey } from "@/config/permissions";
import {
  anyPermissionDoc,
  decidePermission,
  type PermissionPrincipal,
  type VerifyPermissionOptions,
} from "@/modules/middlewares/verify-permission";
import {
  businessNotFound,
  inactiveBusiness,
} from "@/modules/middlewares/verify-tenant-active";
import { AppError } from "@/shared/errors/AppError";
import { moduleNotEnabled } from "@/shared/errors/access-errors";
import { getCompaniesModuleState } from "@/shared/entitlements/entitlement-service";
import { masterModuleRefusal } from "@/shared/entitlements/entitlement-rules";

/**
 * Who may ask for, and watch, the AI reading of a fleet record (AI-1).
 *
 * The routes used to check only that somebody was logged in: a read-only
 * user, or a driver, could start paid analyses on any record of the company
 * — the FLEET module switched off included. The reading of a fuelling is a
 * write on the fuelling (it changes its verdict), so it takes that record's
 * own permission, and the module gate of the fleet.
 */

type AIRecordType = "fuel" | "checklist";

const RECORD_PERMISSION: Record<AIRecordType, PermissionKey> = {
  fuel: "fuel_manage",
  checklist: "vehicle_checklist_manage",
};

interface AIRecordPrincipal extends PermissionPrincipal {
  id: string;
  businessId: string | null;
}

/**
 * The record type's own permission, decided from the route's params. One
 * guard for both types, documented as "either" because the key depends on
 * `recordType`.
 */
function verifyRecordPermission(
  access: "read" | "write",
  options: VerifyPermissionOptions = {},
) {
  const hook = (
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    const { recordType } = (request.params ?? {}) as { recordType?: string };

    // An unknown type is the params schema's 400, answered before this runs.
    const key = RECORD_PERMISSION[recordType as AIRecordType];

    if (!key) {
      done();
      return;
    }

    const refusal = decidePermission(
      request.user as PermissionPrincipal,
      key,
      access,
      options,
    );

    done(refusal ?? undefined);
  };

  return Object.assign(
    hook,
    anyPermissionDoc([
      { key: "fuel_manage", access },
      { key: "vehicle_checklist_manage", access },
    ]),
  );
}

function aiRecordNotFound(): AppError {
  return new AppError("Registro não encontrado!", 404, "AI_RECORD_NOT_FOUND");
}

/**
 * A MASTER names no company in these routes: the record does. The fleet
 * gate is checked on the record's company (decision 4.3), with the same
 * answers the plugin gives when a company is named.
 */
async function assertMasterMayUseFleet(businessId: string): Promise<void> {
  const refusal = masterModuleRefusal(
    [businessId],
    await getCompaniesModuleState([businessId], "FLEET"),
  );

  if (refusal === "company-not-found") throw businessNotFound();
  if (refusal === "company-inactive") throw inactiveBusiness();

  if (refusal === "module-not-enabled") {
    throw moduleNotEnabled(
      "O módulo Gestão de Frota não está habilitado para esta empresa. Habilite-o em Empresas, na opção Módulos Contratados.",
    );
  }
}

interface ScopedRecord {
  id: string;
  businessId: string;
  driverId: string;
}

/**
 * The record, as far as this caller may know it exists.
 *
 * Scoped in the `where`, not checked after: another company's id, or — for
 * a driver — a colleague's record, is answered exactly like an id that does
 * not exist, so the response never confirms that it does.
 */
async function findRecordInScope(
  principal: AIRecordPrincipal,
  recordType: AIRecordType,
  recordId: string,
): Promise<ScopedRecord> {
  // A driver token is a BUSINESS_USER with a driver, as decidePermission
  // reads it; an admin linked to a driver still sees the whole company.
  const isDriver =
    principal.role === "BUSINESS_USER" && Boolean(principal.driverId);

  const scope = {
    id: recordId,
    ...(principal.role !== "MASTER" && {
      businessId: principal.businessId ?? "",
    }),
    ...(isDriver && { driverId: principal.driverId! }),
  };

  const select = { id: true, businessId: true, driverId: true } as const;

  const record =
    recordType === "fuel"
      ? await database.fuel.findFirst({ where: scope, select })
      : await database.vehicleChecklist.findFirst({ where: scope, select });

  if (!record) throw aiRecordNotFound();

  if (principal.role === "MASTER") {
    await assertMasterMayUseFleet(record.businessId);
  }

  return record;
}

export {
  RECORD_PERMISSION,
  aiRecordNotFound,
  findRecordInScope,
  verifyRecordPermission,
};
export type { AIRecordPrincipal, AIRecordType, ScopedRecord };
