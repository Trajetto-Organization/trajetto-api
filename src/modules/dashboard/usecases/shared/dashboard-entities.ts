import type { DashboardEntity } from "../../dtos/dashboard-dto";

/**
 * What the overview and the trends chart count, and who may see each line.
 *
 * One list for both use cases: they used to carry a copy each, and the copies
 * disagreed about which entities a company without a module still received.
 */

type DashboardModule = "FLEET" | "DELIVERIES";

interface DashboardEntityRule {
  key: DashboardEntity;
  permission: string;

  /**
   * The module the company must have hired. Vehicles, drivers, branches and
   * users are the core both modules run on; parts, suppliers, service orders
   * and fines exist only in Frotas (the same keys the FLEET gate protects in
   * shared/entitlements), deliveries and routes only in Entregas.
   */
  module?: DashboardModule;
}

const DASHBOARD_ENTITIES: readonly DashboardEntityRule[] = [
  { key: "vehicle", permission: "vehicle_manage" },
  { key: "driver", permission: "driver_manage" },
  { key: "business", permission: "business_manage" },
  { key: "branch", permission: "branch_manage" },
  { key: "part", permission: "part_manage", module: "FLEET" },
  { key: "supplier", permission: "supplier_manage", module: "FLEET" },
  { key: "service-order", permission: "service_order_manage", module: "FLEET" },
  { key: "user", permission: "user_registration_manage" },
  { key: "fine", permission: "fine_manage", module: "FLEET" },
  { key: "delivery", permission: "delivery_manage", module: "DELIVERIES" },
  { key: "route", permission: "delivery_manage", module: "DELIVERIES" },
];

const MONTH_NAMES = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez",
] as const;

/** The chart's name for an entity ("deliverys" would draw a line of undefined). */
const SERIES_KEY: Record<DashboardEntity, string> = {
  vehicle: "vehicles",
  driver: "drivers",
  business: "businesses",
  branch: "branches",
  part: "parts",
  supplier: "suppliers",
  "service-order": "serviceOrders",
  user: "users",
  fine: "fines",
  delivery: "deliveries",
  route: "routes",
};

interface DashboardViewer {
  role: string;
  profileAccess?: {
    permissions?: Array<{
      permissionKey: string;
      canRead?: boolean;
      canWrite?: boolean;
    }>;
  } | null;
}

/**
 * Only a BUSINESS_USER is limited by a profile; admins and MASTER see all.
 *
 * Read means `canRead`, and nothing else: a write-only row is no access at
 * all for verifyPermission (ROUTE-KEY-1), so the overview must not hand over
 * the numbers the section's own endpoint refuses with 403.
 */
function canReadKey(viewer: DashboardViewer, permissionKey: string): boolean {
  if (viewer.role !== "BUSINESS_USER") return true;

  return (
    viewer.profileAccess?.permissions?.some(
      (permission) =>
        permission.permissionKey === permissionKey &&
        permission.canRead === true,
    ) ?? false
  );
}

/**
 * The entities this viewer is shown: allowed by the profile AND hired by the
 * company. A permission is what a PERSON may do, an entitlement is what the
 * company bought; a BUSINESS_ADMIN passes every permission check by
 * definition and would otherwise get a fleet chart in a deliveries-only
 * company (DASH-MOD-1).
 *
 * `isModuleEnabled` is null for a MASTER's global view: no single company,
 * nothing to ask.
 */
function visibleDashboardEntities(
  viewer: DashboardViewer,
  isModuleEnabled: ((module: DashboardModule) => boolean) | null,
): DashboardEntityRule[] {
  return DASHBOARD_ENTITIES.filter((entity) => {
    if (viewer.role === "BUSINESS_ADMIN" && entity.key === "business") {
      return false;
    }

    if (entity.module && isModuleEnabled && !isModuleEnabled(entity.module)) {
      return false;
    }

    return canReadKey(viewer, entity.permission);
  });
}

/** "Set" for "2026-09". */
function monthLabel(monthKey: string): string {
  return MONTH_NAMES[Number(monthKey.slice(5, 7)) - 1];
}

export {
  DASHBOARD_ENTITIES,
  SERIES_KEY,
  canReadKey,
  monthLabel,
  visibleDashboardEntities,
};
export type { DashboardEntityRule, DashboardModule, DashboardViewer };
