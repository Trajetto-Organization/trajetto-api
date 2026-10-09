import {
  decidePermission,
  type PermissionPrincipal,
} from "@/modules/middlewares/verify-permission";

/**
 * Who answers the tower's requests (decision 6.3): exactly the decide route's
 * guard — MASTER, BUSINESS_ADMIN, or a profile that writes `delivery_manage`;
 * never a driver token.
 *
 * One rule for both doors: the panel's own report of a type that asks the
 * tower counts as authorized by its author only when that author could have
 * approved it in the queue. A profile that reports occurrences but only reads
 * deliveries files a request like a driver does, instead of authorizing
 * through the report what the queue refuses it.
 */
function canDecideAuthorizations(user: PermissionPrincipal): boolean {
  return (
    decidePermission(user, "delivery_manage", "write", { allowDriver: false }) === null
  );
}

export { canDecideAuthorizations };
