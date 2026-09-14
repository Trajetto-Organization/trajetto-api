import database from "@/../infra/database";
import { BusinessModule } from "@prisma/client";

import { isModuleEnabled } from "./entitlement-rules";

/**
 * The one place that answers "what did this company hire?". Modules come
 * from BusinessEntitlement; numeric limits (vehicle_limit, ai_analysis_limit)
 * stay as Business columns and are read by their own flows — this service
 * only owns the module on/off.
 */

interface BusinessEntitlementRow {
  module: BusinessModule;
  enabled: boolean;
}

async function getBusinessEntitlements(
  businessId: string,
): Promise<BusinessEntitlementRow[]> {
  const rows = await database.businessEntitlement.findMany({
    where: { businessId },
    select: { module: true, enabled: true },
    orderBy: { module: "asc" },
  });

  return rows;
}

async function hasModule(
  businessId: string,
  module: BusinessModule,
): Promise<boolean> {
  const rows = await getBusinessEntitlements(businessId);
  return isModuleEnabled(rows, module);
}

async function setModuleEnabled(
  businessId: string,
  module: BusinessModule,
  enabled: boolean,
): Promise<void> {
  await database.businessEntitlement.upsert({
    where: { businessId_module: { businessId, module } },
    create: { businessId, module, enabled },
    update: { enabled },
  });
}

/**
 * What a company actually has riding on a module, counted at the moment the
 * master is about to switch it off.
 *
 * It exists to answer the only question that matters on that screen — "what
 * am I about to take away?" — with numbers instead of adjectives. Nothing
 * here is deleted by disabling: the counts describe what becomes unreachable,
 * not what disappears.
 */
interface ModuleImpact {
  module: BusinessModule;
  /** Records that stop being reachable, by label, for the confirm dialog. */
  records: Array<{ label: string; count: number }>;
  /** Company users whose menu loses items — MASTER excluded, it bypasses. */
  affectedUsers: number;
  /** Work in flight, which is what makes the timing of the switch matter. */
  inFlight: Array<{ label: string; count: number }>;
}

/** Permission keys each module gates, mirroring the API route guards. */
const MODULE_PERMISSION_KEYS: Record<BusinessModule, string[]> = {
  FLEET: [
    "fuel_manage",
    "vehicle_checklist_manage",
    "service_order_manage",
    "service_order_part_manage",
    "account_payable_manage",
    "fine_manage",
    "part_manage",
    "supplier_manage",
  ],
  DELIVERIES: ["delivery_manage", "occurrence_manage"],
};

async function countAffectedUsers(
  businessId: string,
  module: BusinessModule,
): Promise<number> {
  return database.user.count({
    where: {
      businessId,
      access_revoked: false,
      profileAccess: {
        permissions: {
          some: { permissionKey: { in: MODULE_PERMISSION_KEYS[module] } },
        },
      },
    },
  });
}

async function getFleetImpact(businessId: string): Promise<ModuleImpact> {
  const where = { businessId };

  const [
    fuels,
    checklists,
    serviceOrders,
    accountPayables,
    fines,
    parts,
    suppliers,
    openServiceOrders,
    affectedUsers,
  ] = await Promise.all([
    database.fuel.count({ where }),
    database.vehicleChecklist.count({ where }),
    database.serviceOrder.count({ where }),
    database.accountPayable.count({ where }),
    database.fine.count({ where }),
    database.part.count({ where }),
    database.supplier.count({ where }),
    // No completion date = still open on the shop floor.
    database.serviceOrder.count({
      where: { businessId, completion_date: null },
    }),
    countAffectedUsers(businessId, "FLEET"),
  ]);

  return {
    module: "FLEET",
    records: [
      { label: "Abastecimentos", count: fuels },
      { label: "Checklists", count: checklists },
      { label: "Ordens de serviço", count: serviceOrders },
      { label: "Contas a pagar", count: accountPayables },
      { label: "Multas", count: fines },
      { label: "Peças", count: parts },
      { label: "Fornecedores", count: suppliers },
    ],
    affectedUsers,
    inFlight: [{ label: "Ordens de serviço em aberto", count: openServiceOrders }],
  };
}

async function getDeliveriesImpact(businessId: string): Promise<ModuleImpact> {
  const where = { businessId };

  const [
    deliveries,
    shippers,
    occurrenceTypes,
    pending,
    inTransit,
    affectedUsers,
  ] = await Promise.all([
    database.delivery.count({ where }),
    database.shipper.count({ where }),
    database.occurrenceType.count({ where }),
    database.delivery.count({ where: { businessId, status: "PENDING" } }),
    database.delivery.count({ where: { businessId, status: "IN_TRANSIT" } }),
    countAffectedUsers(businessId, "DELIVERIES"),
  ]);

  return {
    module: "DELIVERIES",
    records: [
      { label: "Entregas", count: deliveries },
      { label: "Embarcadores", count: shippers },
      { label: "Tipos de ocorrência", count: occurrenceTypes },
    ],
    affectedUsers,
    inFlight: [
      { label: "Entregas pendentes", count: pending },
      { label: "Entregas em rota", count: inTransit },
    ],
  };
}

async function getModuleImpact(
  businessId: string,
  module: BusinessModule,
): Promise<ModuleImpact> {
  return module === "FLEET"
    ? getFleetImpact(businessId)
    : getDeliveriesImpact(businessId);
}

export {
  getBusinessEntitlements,
  hasModule,
  setModuleEnabled,
  getModuleImpact,
  MODULE_PERMISSION_KEYS,
};
export type { BusinessEntitlementRow, ModuleImpact };
