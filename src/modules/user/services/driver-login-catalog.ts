import { sendCatalogChangedEvent } from "@/websocket";

/**
 * A driver's app login is part of the driver catalogue the web reads: the
 * chat pickers list drivers "com o app" apart from those without one, under
 * the `driver` query keys. When a login of a driver is created, re-linked,
 * revoked, restored or deleted, the company's open tabs are told
 * (`catalogChanged` driver, decision 2.3). Called after the commit, like
 * every catalogue hint: a rolled-back write must not make tabs refetch.
 *
 * Each company is told once, whatever the number of links that moved there.
 */
function announceDriverLoginChange(
  ...businessIds: Array<string | null | undefined>
): void {
  const companies = new Set(
    businessIds.filter(
      (id): id is string => typeof id === "string" && id !== "",
    ),
  );

  for (const businessId of companies) {
    sendCatalogChangedEvent(businessId, "driver");
  }
}

export { announceDriverLoginChange };
