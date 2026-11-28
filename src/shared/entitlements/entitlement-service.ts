import database from "@/../infra/database";
import { BusinessModule, Prisma } from "@prisma/client";

import { isModuleEnabled, isModuleSwitchedOff } from "./entitlement-rules";

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
  client: Prisma.TransactionClient = database,
): Promise<BusinessEntitlementRow[]> {
  const rows = await client.businessEntitlement.findMany({
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

/**
 * Whether the MASTER switched `module` off for the company (see
 * isModuleSwitchedOff): what holds the company's webhooks while Entregas is
 * off (plan M3). Read from the database on every call — never cached, so a
 * switch is seen by every replica at its next send.
 */
async function hasModuleSwitchedOff(
  businessId: string,
  module: BusinessModule,
  client: Prisma.TransactionClient = database,
): Promise<boolean> {
  const row = await client.businessEntitlement.findUnique({
    where: { businessId_module: { businessId, module } },
    select: { module: true, enabled: true },
  });

  return isModuleSwitchedOff(row ? [row] : [], module);
}

interface CompanyModuleState {
  id: string;
  isActive: boolean;
  moduleEnabled: boolean;
}

/**
 * For each id that names an existing company: whether it is active and has
 * `module` on. An id with no company is simply absent from the answer.
 *
 * One query for all of them, because the MASTER's module gate checks every
 * company a request names, and must tell "no such company" and "company
 * switched off" apart from "module not hired" — the web offers to enable the
 * module on the last one only.
 */
async function getCompaniesModuleState(
  businessIds: readonly string[],
  module: BusinessModule,
): Promise<CompanyModuleState[]> {
  if (businessIds.length === 0) return [];

  const rows = await database.business.findMany({
    where: { id: { in: [...businessIds] } },
    select: {
      id: true,
      is_active: true,
      entitlements: {
        where: { module },
        select: { module: true, enabled: true },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    isActive: row.is_active,
    moduleEnabled: isModuleEnabled(row.entitlements, module),
  }));
}

/**
 * `client` is the plan change's transaction: the switch and the event that
 * announces it commit together (OUTBOX-10).
 */
async function setModuleEnabled(
  businessId: string,
  module: BusinessModule,
  enabled: boolean,
  client: Prisma.TransactionClient = database,
): Promise<void> {
  await client.businessEntitlement.upsert({
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
  /** Company users whose menu loses items; the MASTER belongs to no company. */
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

// Not async: the deliveries impact batches this query with its counts.
function countAffectedUsers(businessId: string, module: BusinessModule) {
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
    inFlight: [
      { label: "Ordens de serviço em aberto", count: openServiceOrders },
    ],
  };
}

async function getDeliveriesImpact(businessId: string): Promise<ModuleImpact> {
  const where = { businessId };

  // One connection for all of them (a batch runs in order on one), not one
  // connection per count: the dialog must not take the pool's share of a
  // replica while it opens.
  const [
    deliveries,
    shippers,
    occurrenceTypes,
    pending,
    inTransit,
    routesInProgress,
    activeWebhooks,
    affectedUsers,
  ] = await database.$transaction([
    database.delivery.count({ where }),
    database.shipper.count({ where }),
    // The company's own types: the four defaults the platform seeds
    // (system_key) are not something the company would lose.
    database.occurrenceType.count({ where: { businessId, system_key: null } }),
    database.delivery.count({ where: { businessId, status: "PENDING" } }),
    database.delivery.count({ where: { businessId, status: "IN_TRANSIT" } }),
    // Plan M3 (D51): a route on the street is not cancelled by the switch —
    // it stays IN_PROGRESS, the app hides the day and keeps the proofs
    // queued — so the master must see it before confirming.
    database.route.count({ where: { businessId, status: "IN_PROGRESS" } }),
    // The customer's ERP stops hearing: these endpoints' events are held
    // until the module is back (webhook-dispatch-service, `deliver`).
    database.webhookEndpoint.count({ where: { businessId, is_active: true } }),
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
      { label: "Rotas em andamento", count: routesInProgress },
      { label: "Entregas pendentes", count: pending },
      { label: "Entregas em rota", count: inTransit },
      {
        label: "Webhooks ativos (pausados até religar)",
        count: activeWebhooks,
      },
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
  getCompaniesModuleState,
  hasModule,
  hasModuleSwitchedOff,
  setModuleEnabled,
  getModuleImpact,
  MODULE_PERMISSION_KEYS,
};
export type { BusinessEntitlementRow, CompanyModuleState, ModuleImpact };
