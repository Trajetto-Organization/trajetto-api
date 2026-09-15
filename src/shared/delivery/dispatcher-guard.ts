import { AppError } from "@/shared/errors/AppError";

/**
 * Management of the operation belongs to the dispatcher, never to the driver.
 *
 * This exists because `delivery_manage` is deliberately open to drivers: the
 * app's own surface — list the day, depart, register an arrival, prove a
 * delivery — runs on that permission, and the middleware cannot tell those
 * calls apart from "create a delivery" or "plan a route". So the permission
 * table says yes and the use case says no, and this is the sentence that says
 * it.
 *
 * Spelled once and shared rather than copied into each use case, which is how
 * it was: an authorization rule with eleven copies is an authorization rule
 * with eleven chances to be forgotten in the twelfth. The route module was
 * exactly that — `create-route` shipped without it, and a driver's own token
 * could plan a route for the whole company.
 *
 * `driverId` on the user, not the role, is the right test: a driver logs in as
 * a BUSINESS_USER like anyone else, and what distinguishes them is being
 * linked to a driver record.
 */
function assertDispatcher(user: { driverId?: string | null }): void {
  if (!user.driverId) return;

  throw new AppError(
    "Motoristas não gerenciam entregas: criação, edição e atribuição são do despachante.",
    403,
    "DRIVER_CANNOT_MANAGE_DELIVERIES",
  );
}

export { assertDispatcher };
