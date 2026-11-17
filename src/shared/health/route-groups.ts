import { RETIRED_ROUTES } from "@/routes/retired-routes";

/**
 * Which of twelve fixed groups each route counts in, for the HTTP counters
 * and the latency histogram (plano-escala F1-09).
 *
 * The scale plan decides by group: positions are the GPS ingest that may
 * get a process of its own ("posições > 30% da CPU do HTTP"), the tower is
 * the heaviest live read, lists and details are the panel's reads under the
 * p95 < 300 ms SLO, driver writes are what the app waits on, auth is where
 * bcrypt spends the threadpool, files are the long uploads, exports and
 * PDFs that would wreck any other group's p95. Twelve, never more, and
 * never a label built from data (a businessId, a path with its ids): the
 * series stays the same size whatever the traffic.
 *
 * EVERY route is listed here by its pattern, on purpose. A rule by prefix
 * would put a new heavy list under /delivery in "details" without anyone
 * deciding it; here a route that is not listed fails
 * tests/unitaires/health/route-groups.test.ts, which reads every route
 * Fastify registers (onRoute), and so does an entry left behind by a route
 * that was removed. At runtime an unlisted route, a 404 (no route) and a
 * CORS preflight count as "other". Retired routes (retired-routes.ts) are
 * "other" without being listed twice; HEAD counts as its GET, and a
 * pattern with a trailing slash as the one without (a plugin's "/" under a
 * prefix answers on both).
 */
const ROUTE_GROUPS = [
  "positions",
  "tower",
  "lists",
  "details",
  "driver_writes",
  "panel_writes",
  "auth",
  "integration",
  "notifications",
  "files",
  "chat",
  "other",
] as const;

type RouteGroup = (typeof ROUTE_GROUPS)[number];

/** `METHOD /pattern`, as Fastify registers the route. */
const ROUTE_GROUP_TABLE: Readonly<Record<RouteGroup, readonly string[]>> = {
  positions: ["POST /route/positions"],
  tower: [
    "GET /dashboard/overview",
    "GET /dashboard/trends",
    "GET /delivery/operation-summary",
    "GET /route/control-tower",
    "GET /route/live",
    "GET /route/driver-trail/:driverId",
    "GET /route/monitoring",
    "GET /route/monitoring/drivers",
  ],
  lists: [
    "GET /business/list-business",
    "GET /business/search-business",
    "GET /branch/list-branch",
    "GET /branch/search-branch-business",
    "GET /supplier/list-supplier",
    "GET /supplier/search-supplier-business",
    "GET /vehicle-type/list-vehicle-type",
    "GET /vehicle-type/search-vehicle-type-business",
    "GET /fuel-type/list-fuel-type",
    "GET /fuel-type/search-fuel-type-business",
    "GET /fuel/list-fuel",
    "GET /fuel/search-fuel-by-vehicle/:vehicleId",
    "GET /part/list-part",
    "GET /part/search-part-business",
    "GET /driver/list-driver",
    "GET /driver/search-driver-business",
    "GET /vehicle/list-vehicle",
    "GET /vehicle/search-vehicle-business",
    "GET /vehicle-checklist/list-vehicle-checklist",
    "GET /service-order/list-service-order",
    "GET /service-order/search-service-order-business",
    "GET /service-order/search-service-order-by-vehicle/:vehicleId",
    "GET /service-order/mine",
    "GET /service-order-part/list-service-order-part",
    "GET /account-payable/list-account-payable",
    "GET /account-payable/search-account-payable-by-responsible-user",
    "GET /profile-access/list-profile-access",
    "GET /profile-access/search-profile-business",
    "GET /permission/list-permission",
    "GET /permission/list-by-profile/:profileAccessId",
    "GET /user/list-user",
    "GET /user/search-user-business",
    "GET /user/:userId/devices",
    "GET /user/list-master-users",
    "GET /quote/list-quote",
    "GET /kanban/list/:businessId",
    "GET /fines/list-fine",
    "GET /traffic-violation/list-traffic-violation-codes",
    "GET /traffic-violation/search-traffic-violation-codes",
    "GET /shipper/list-shipper",
    "GET /shipper/search-shipper-business",
    "GET /occurrence-type/list-occurrence-type",
    "GET /status-change-reason/list-status-change-reason",
    "GET /delivery/list-delivery",
    "GET /delivery/list-occurrences",
    "GET /delivery/my-deliveries/:businessId",
    "GET /delivery/occurrence-authorizations",
    "GET /delivery/message-templates",
    "GET /delivery/proof-audits",
    "GET /route/list-routes",
    "GET /route/unrouted-deliveries/:businessId",
    "GET /route/open-stops/:businessId",
    "GET /route/assignment-preview/:businessId",
    "GET /import/list-imports",
    "GET /address-search/:businessId",
    "GET /driver-pause/report/:businessId",
    "GET /integrations/api-keys",
    "GET /integrations/webhook-endpoints",
    "GET /integrations/webhook-deliveries",
  ],
  details: [
    "GET /business/get-ai-usage/:businessId",
    "GET /business/entitlements/:businessId",
    "GET /business/entitlements/:businessId/impact/:module",
    "GET /business/:businessId/settings",
    "GET /fuel/get-previous-fuel/:vehicleId",
    "GET /vehicle/get-vehicle/:vehicleId/business/:businessId",
    "GET /service-order/:serviceOrderId",
    "GET /account-payable/:accountPayableId",
    "GET /user/me",
    "GET /kanban/card/:cardId",
    "GET /whatsapp/settings",
    "GET /ai-analysis/progress/:recordType/:recordId",
    "GET /delivery/get-delivery/:deliveryId/business/:businessId",
    "GET /route/get-route/:routeId/business/:businessId",
    "GET /import/get-import/:importId/business/:businessId",
    "GET /driver-pause/current/:businessId",
    "GET /public/verify-proof/:token",
    "GET /public/track/:token",
    "GET /integrations/api-usage",
    "GET /config/map",
  ],
  driver_writes: [
    "POST /fuel/create-fuel/:businessId",
    "POST /vehicle-checklist/create-vehicle-checklist/:businessId",
    "POST /delivery/start-route/:businessId",
    "POST /delivery/arrival/:deliveryId/business/:businessId",
    "POST /delivery/proof/:deliveryId/business/:businessId",
    "POST /delivery/report-occurrence/:deliveryId/business/:businessId",
    "POST /route/start-route/:routeId/business/:businessId",
    "POST /route/on-the-way/:stopId/route/:routeId/business/:businessId",
    "POST /driver-pause/start/:businessId",
    "POST /driver-pause/end/:businessId",
  ],
  panel_writes: [
    "POST /business/create-business",
    "PATCH /business/update-business/:businessId",
    "PATCH /business/update-ai-limit/:businessId",
    "PATCH /business/update-vehicle-limit/:businessId",
    "PUT /business/entitlements/:businessId",
    "PUT /business/:businessId/settings",
    "POST /business/request-business-deletion/:businessId",
    "DELETE /business/delete-business/:businessId",
    "PATCH /business/toggle-business-active/:businessId",
    "POST /branch/create-branch/:businessId",
    "PATCH /branch/update-branch/:branchId/business/:businessId",
    "POST /branch/request-branch-deletion/:branchId/business/:businessId",
    "DELETE /branch/delete-branch/:branchId/business/:businessId",
    "PATCH /branch/toggle-branch-active/:branchId/business/:businessId",
    "POST /supplier/create-supplier/:businessId",
    "PATCH /supplier/update-supplier/:supplierId/business/:businessId",
    "DELETE /supplier/delete-supplier/:supplierId/business/:businessId",
    "POST /vehicle-type/create-vehicle-type/:businessId",
    "PATCH /vehicle-type/update-vehicle-type/:vehicleTypeId/business/:businessId",
    "DELETE /vehicle-type/delete-vehicle-type/:vehicleTypeId/business/:businessId",
    "POST /fuel-type/create-fuel-type/:businessId",
    "PATCH /fuel-type/update-fuel-type/:fuelTypeId/business/:businessId",
    "DELETE /fuel-type/delete-fuel-type/:fuelTypeId/business/:businessId",
    "PATCH /fuel/update-fuel/:fuelId/business/:businessId",
    "DELETE /fuel/delete-fuel/:fuelId/business/:businessId",
    "POST /part/create-part/:businessId",
    "PATCH /part/update-part/:partId/business/:businessId",
    "DELETE /part/delete-part/:partId/business/:businessId",
    "POST /driver/create-driver/:businessId",
    "PATCH /driver/update-driver/:driverId/business/:businessId",
    "DELETE /driver/delete-driver/:driverId/business/:businessId",
    "POST /vehicle/create-vehicle/:businessId",
    "PATCH /vehicle/update-vehicle/:vehicleId/business/:businessId",
    "DELETE /vehicle/delete-vehicle/:vehicleId/business/:businessId",
    "PATCH /vehicle-checklist/update-vehicle-checklist/:checklistId/business/:businessId",
    "DELETE /vehicle-checklist/delete-vehicle-checklist/:checklistId/business/:businessId",
    "POST /service-order/create-service-order/:businessId",
    "PATCH /service-order/update-service-order/:serviceOrderId/business/:businessId",
    "DELETE /service-order/delete-service-order/:serviceOrderId/business/:businessId",
    "POST /service-order-part/create-service-order-part/:serviceOrderId/business/:businessId",
    "PATCH /service-order-part/update-service-order-part/:serviceOrderPartId/serviceOrder/:serviceOrderId/business/:businessId",
    "DELETE /service-order-part/delete-service-order-part/:serviceOrderPartId/serviceOrder/:serviceOrderId/business/:businessId",
    "POST /account-payable/create-account-payable/:businessId",
    "PATCH /account-payable/update-account-payable/:accountPayableId/business/:businessId",
    "DELETE /account-payable/delete-account-payable/:accountPayableId/business/:businessId",
    "POST /profile-access/create-profile-access",
    "PATCH /profile-access/update-profile-access/:profileAccessId",
    "DELETE /profile-access/delete-profile-access/:profileAccessId",
    "POST /permission/create-permission",
    "PATCH /permission/update-permission/:permissionId",
    "DELETE /permission/delete-permission/:permissionId",
    "POST /permission/bulk-configure-permissions",
    "POST /user/create-user",
    "DELETE /user/delete-user/:userId",
    "PATCH /user/update-user/:userId",
    "PATCH /user/username",
    "PATCH /user/revoke-access/:userId",
    "DELETE /user/:userId/devices/:deviceId",
    "PATCH /user/avatar",
    "DELETE /user/avatar",
    "POST /user/create-master-user",
    "PATCH /user/update-master-user/:masterUserId",
    "DELETE /user/delete-master-user/:masterUserId",
    "PATCH /quote/update-quote-status/:quoteId",
    "DELETE /quote/delete-quote/:quoteId",
    "POST /kanban/column/create/:businessId",
    "PATCH /kanban/column/update/:columnId/business/:businessId",
    "DELETE /kanban/column/delete/:columnId/business/:businessId",
    "POST /kanban/columns/reorder",
    "POST /kanban/card/create",
    "PATCH /kanban/card/update/:cardId",
    "DELETE /kanban/card/delete/:cardId",
    "POST /kanban/cards/reorder",
    "POST /fines/create-fine/:businessId",
    "PATCH /fines/update-fine/:fineId/business/:businessId",
    "DELETE /fines/delete-fine/:fineId/business/:businessId",
    "PATCH /whatsapp/settings",
    "POST /ai-analysis/request/:recordType/:recordId",
    "POST /shipper/create-shipper/:businessId",
    "PATCH /shipper/update-shipper/:shipperId/business/:businessId",
    "DELETE /shipper/delete-shipper/:shipperId/business/:businessId",
    "POST /occurrence-type/create-occurrence-type/:businessId",
    "PATCH /occurrence-type/update-occurrence-type/:occurrenceTypeId/business/:businessId",
    "DELETE /occurrence-type/delete-occurrence-type/:occurrenceTypeId/business/:businessId",
    "POST /status-change-reason/create-status-change-reason/:businessId",
    "PATCH /status-change-reason/update-status-change-reason/:reasonId/business/:businessId",
    "DELETE /status-change-reason/delete-status-change-reason/:reasonId/business/:businessId",
    "POST /delivery/create-delivery/:businessId",
    "POST /delivery/reactivate-customer-messages/:deliveryId/business/:businessId",
    "PATCH /delivery/update-delivery/:deliveryId/business/:businessId",
    "PATCH /delivery/update-delivery-status/:deliveryId/business/:businessId",
    "PATCH /delivery/assign-deliveries/:businessId",
    "POST /delivery/occurrence-authorization/:occurrenceId/business/:businessId",
    "PUT /delivery/message-template/:businessId",
    "PATCH /delivery/proof-audit/:auditId/business/:businessId",
    "POST /route/create-route/:businessId",
    "PATCH /route/update-route/:routeId/business/:businessId",
    "PATCH /route/release-route/:routeId/business/:businessId",
    "PATCH /route/cancel-route/:routeId/business/:businessId",
    "POST /route/close-with-pending/:routeId/business/:businessId",
    "POST /route/add-stops/:routeId/business/:businessId",
    "DELETE /route/remove-stop/:stopId/route/:routeId/business/:businessId",
    "PATCH /route/reorder-stops/:routeId/business/:businessId",
    "POST /route/remove-stops/:routeId/business/:businessId",
    "POST /route/move-stops/:routeId/business/:businessId",
    "PATCH /route/set-delivery-location/:deliveryId/business/:businessId",
    "POST /import/reverse-import/:importId/business/:businessId",
    "POST /integrations/api-key/:businessId",
    "DELETE /integrations/api-key/:id/business/:businessId",
    "POST /integrations/webhook-endpoint/:businessId",
    "PUT /integrations/webhook-endpoint/:id/business/:businessId",
    "POST /integrations/webhook-endpoint/:id/business/:businessId/reactivate",
    "POST /integrations/webhook-endpoint/:id/business/:businessId/test",
    "POST /integrations/webhook-endpoint/:id/business/:businessId/rotate-secret",
    "DELETE /integrations/webhook-endpoint/:id/business/:businessId",
    "POST /integrations/webhook-delivery/:id/business/:businessId/resend",
  ],
  auth: [
    "POST /user/session",
    "POST /user/session/enroll",
    "POST /user/session/revoke",
    "GET /user/forgot-verification",
    "POST /user/reset/password",
    "POST /user/forgot/password",
    "POST /user/refresh-token",
    "POST /user/logout",
    "POST /user/socket-ticket",
    "POST /user/two-factor-verification",
    "POST /user/email-verification",
    "POST /user/resend-two-factor-code",
    "POST /user/me/password",
    "GET /user/me/sessions",
    "DELETE /user/me/sessions/:id",
    "PATCH /user/password",
    "PATCH /user/twofactor",
    "POST /user/:userId/enrollment",
    "PATCH /user/:userId/driver-password",
  ],
  integration: [
    "GET /integration/docs/openapi.json",
    "GET /integration/docs",
    "GET /webhooks/whatsapp",
    "POST /webhooks/whatsapp",
    "POST /webhooks/resend",
    "GET /integration/v1/catalogue",
    "GET /integration/v1/deliveries",
    "GET /integration/v1/deliveries/:id",
    "GET /integration/v1/routes",
    "GET /integration/v1/routes/:id",
    "GET /integration/v1/events",
    "POST /integration/v1/deliveries",
    "POST /integration/v1/deliveries/:id/cancel",
  ],
  notifications: [
    "GET /notification/stream",
    "GET /notification/unread-count",
    "PATCH /notification/:notificationId/read",
    "DELETE /notification/:notificationId",
    "PATCH /notification/read-all",
    "POST /notification/read-by-entity",
    "POST /notification/push-token",
    "DELETE /notification/push-token",
    "GET /notification/preferences",
    "PUT /notification/preferences",
    "GET /activity/list",
    "GET /activity/list-cursor",
    "GET /activity/summary",
  ],
  files: [
    "GET /tmp/*",
    "GET /fuel/export-fuel",
    "GET /driver/export-driver",
    "GET /vehicle/export-vehicle",
    "GET /vehicle-checklist/export-vehicle-checklist",
    "GET /service-order/export-service-order",
    "GET /account-payable/export-account-payable",
    "GET /fines/export-fine",
    "POST /delivery/import-xml/:businessId",
    "GET /delivery/export-delivery",
    "GET /delivery/export-occurrence",
    "GET /delivery/proof-document/:deliveryId/business/:businessId",
    "GET /import/download-template",
    "POST /import/import-spreadsheet/:businessId",
    "POST /uploads/presign/:businessId",
    "POST /uploads/avatar/presign",
    "PUT /uploads/local",
    "GET /public/delivery-proof/:token",
    "GET /assets/trajetto-logo.png",
  ],
  chat: [
    "GET /chat/list-threads",
    "GET /chat/list-messages",
    "GET /chat/search-messages",
    "GET /chat/recipients",
    "POST /chat/send-message",
    "GET /chat/attachment-url",
    "POST /chat/mark-read",
    "POST /chat/mark-delivered",
    "GET /chat/tickets",
    "GET /chat/tickets/summary",
    "GET /chat/tickets/assignees",
    "GET /chat/tickets/:ticketId",
    "POST /chat/tickets",
    "POST /chat/tickets/:ticketId/close",
    "POST /chat/tickets/:ticketId/assign",
    "POST /chat/tickets/:ticketId/reopen",
    "GET /chat/tickets/:ticketId/events",
    "GET /chat/tickets/:ticketId/messages",
    "POST /chat/tickets/:ticketId/messages",
    "POST /chat/tickets/:ticketId/read",
  ],
  other: [
    "GET /docs",
    "GET /docs/static/index.html",
    "GET /docs/static/swagger-initializer.js",
    "GET /docs/json",
    "GET /docs/yaml",
    "GET /docs/static/*",
    "GET /robots.txt",
    "GET /sitemap.xml",
    "POST /quote/create-quote",
    "POST /diagnostics/client",
    "POST /public/track/:token/opt-out",
    "GET /health",
    "GET /health/liveness",
    "GET /health/readiness",
    "GET /health/rollout",
    "GET /health/metrics",
    "GET /health/providers",
    "GET /health/dead-letter",
    "GET /health/dead-letter/events",
    "POST /health/dead-letter/replay",
    "POST /health/dead-letter/events/replay",
  ],
};

/** url → method → group: the lookup on every response allocates nothing. */
const groupsByUrl = new Map<string, Map<string, RouteGroup>>();

function addRoute(method: string, url: string, group: RouteGroup): void {
  let byMethod = groupsByUrl.get(url);

  if (!byMethod) {
    byMethod = new Map();
    groupsByUrl.set(url, byMethod);
  }

  byMethod.set(method, group);
}

for (const group of ROUTE_GROUPS) {
  for (const route of ROUTE_GROUP_TABLE[group]) {
    const separator = route.indexOf(" ");

    addRoute(route.slice(0, separator), route.slice(separator + 1), group);
  }
}

for (const retired of RETIRED_ROUTES) {
  addRoute(retired.method, retired.url, "other");
}

/**
 * The group of a route, by its method and its registered pattern
 * (`request.routeOptions.url`); undefined when the route is not listed.
 * Without a pattern (a 404) or for a CORS preflight it is "other".
 */
function routeGroupOf(
  method: string,
  url: string | undefined,
): RouteGroup | undefined {
  if (url === undefined || method === "OPTIONS") return "other";

  const pattern = url.length > 1 && url.endsWith("/") ? url.slice(0, -1) : url;

  return groupsByUrl.get(pattern)?.get(method === "HEAD" ? "GET" : method);
}

export { ROUTE_GROUPS, ROUTE_GROUP_TABLE, routeGroupOf };
export type { RouteGroup };
