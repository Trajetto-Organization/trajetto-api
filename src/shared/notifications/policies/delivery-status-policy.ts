import { NotificationCategory } from "@prisma/client";

import {
  DeliveryStatusOverriddenPayload,
  NotificationPolicyEntry,
  RenderedPush,
} from "../notification-types";

import type { User } from "@/modules/user/dtos/user-dto";
import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";

/**
 * The one thing a dispatcher can do to a delivery that the driver cannot see.
 *
 * Everything else that changes a delivery is something the driver themselves
 * did — an arrival, a proof, an occurrence — and their own screen already
 * shows it. An override comes from the panel, and until this existed the
 * delivery simply VANISHED from their list on the next sync, with the app's
 * seven-day offline cache making the gap longer rather than shorter. The
 * driver drove to an address that had been called off two hours earlier.
 *
 * Push-only and mandatory, exactly like the route notifications: the tray has
 * to ring with the app closed, because the driver is not looking at the phone,
 * they are working — and preferences control noise, not the company telling
 * somebody their day changed.
 */
async function recipientDriver(
  driverUserId: string | null,
  users: IUserRepository,
): Promise<User[]> {
  if (!driverUserId) return [];

  const user = await users.findUserById(driverUserId);

  return user ? [user] : [];
}

function renderDeliveryStatusOverriddenPush(
  payload: DeliveryStatusOverriddenPayload,
): RenderedPush {
  const detail = payload.note
    ? `${payload.reason} — ${payload.note}`
    : payload.reason;

  return {
    // The two cases read differently on a lock screen, and the driver who is
    // on the way to the address needs the stronger one.
    title: payload.removedFromWorklist
      ? "⛔ Entrega retirada da sua lista"
      : "Nova entrega na sua lista",

    body: `${payload.recipientName} (${payload.addressLabel}): ${payload.fromLabel} → ${payload.toLabel}. ${detail}`,

    // Straight to the list, not the feed: what the driver needs is to see
    // which stops are still theirs.
    data: { url: "/deliveries" },
  };
}

const deliveryStatusOverriddenPolicy: NotificationPolicyEntry<DeliveryStatusOverriddenPayload> =
  {
    category: NotificationCategory.TASKS,
    mandatory: true,

    async resolveRecipients(payload, deps) {
      return recipientDriver(payload.driverUserId, deps.userRepository);
    },

    renderPush: renderDeliveryStatusOverriddenPush,
  };

export { deliveryStatusOverriddenPolicy, renderDeliveryStatusOverriddenPush };
