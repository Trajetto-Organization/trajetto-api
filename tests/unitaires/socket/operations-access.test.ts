import { describe, expect, it } from "vitest";

import {
  canWatchOperationsOf,
  mayReadDeliveries,
  operationsRoom,
  readOperationsBusinessId,
  type DeliveryPrincipal,
} from "@/shared/socket/operations-access";

/**
 * The rule that decides who sees a fleet move.
 *
 * `socket-operations-room.test.ts` proves it through the real channel, with
 * four connections and a database; this proves the rule itself in
 * milliseconds, so the cheap suite fails first when somebody edits it.
 *
 * Both exist on purpose. A pure rule can be perfect and still be wired to the
 * wrong room, which is exactly the defect this replaced.
 */
const principal = (extra: Partial<DeliveryPrincipal>): DeliveryPrincipal => ({
  role: "BUSINESS_USER",
  driverId: null,
  businessId: "empresa-a",
  permissions: [],
  ...extra,
});

const deliveryRead = [{ permissionKey: "delivery_manage", canRead: true }];

describe("who counts as the dispatch side", () => {
  it("lets in a user whose profile reads deliveries", () => {
    expect(mayReadDeliveries(principal({ permissions: deliveryRead }))).toBe(
      true,
    );
  });

  it("lets in a company administrator with no explicit permissions", () => {
    expect(
      mayReadDeliveries(principal({ role: "BUSINESS_ADMIN", permissions: [] })),
    ).toBe(true);
  });

  it("lets in a MASTER, who belongs to no company", () => {
    // Requiring company membership is what used to leave the master seat out
    // of every room — the reason the tower had no live dots for support.
    expect(
      mayReadDeliveries(
        principal({ role: "MASTER", businessId: null, permissions: null }),
      ),
    ).toBe(true);
  });

  it("keeps out a driver who holds the very same permission", () => {
    /**
     * The whole defect, in one assertion.
     *
     * `verify-permission` hands every driver `delivery_manage` read AND write
     * so the app can list their day and appoint against it. Reading that key
     * as "may watch the operation" is what put every colleague's coordinates
     * on a phone in a cab.
     */
    expect(
      mayReadDeliveries(
        principal({ driverId: "motorista-1", permissions: deliveryRead }),
      ),
    ).toBe(false);
  });

  it("keeps out a driver who is also an administrator", () => {
    // The driver check comes first deliberately: a company that made its
    // owner-operator an admin must not thereby broadcast the fleet to a phone.
    expect(
      mayReadDeliveries(
        principal({ driverId: "motorista-1", role: "BUSINESS_ADMIN" }),
      ),
    ).toBe(false);
  });

  it("keeps out a colleague with a different permission", () => {
    expect(
      mayReadDeliveries(
        principal({
          permissions: [{ permissionKey: "fuel_manage", canRead: true }],
        }),
      ),
    ).toBe(false);
  });

  it("keeps out a user who may write deliveries but not read them", () => {
    expect(
      mayReadDeliveries(
        principal({
          permissions: [{ permissionKey: "delivery_manage", canRead: false }],
        }),
      ),
    ).toBe(false);
  });

  it("keeps out a user with no company", () => {
    // A BUSINESS_USER without a company is a broken record, not a master.
    // Letting them through would mean a room join with no tenant to scope it.
    expect(
      mayReadDeliveries(
        principal({ businessId: null, permissions: deliveryRead }),
      ),
    ).toBe(false);
  });

  it("keeps out a user with no permissions at all", () => {
    expect(mayReadDeliveries(principal({ permissions: undefined }))).toBe(false);
  });
});

describe("which company a socket may watch", () => {
  const staff = {
    role: "BUSINESS_USER",
    businessId: "empresa-a",
    isDeliveryStaff: true,
  };

  it("lets staff watch their own company", () => {
    expect(canWatchOperationsOf(staff, "empresa-a")).toBe(true);
  });

  it("refuses staff asking for another tenant", () => {
    expect(canWatchOperationsOf(staff, "empresa-b")).toBe(false);
  });

  it("lets a MASTER watch whichever company they picked", () => {
    expect(
      canWatchOperationsOf(
        { role: "MASTER", businessId: null, isDeliveryStaff: true },
        "empresa-b",
      ),
    ).toBe(true);
  });

  it("refuses somebody who is not on the dispatch side", () => {
    expect(
      canWatchOperationsOf({ ...staff, isDeliveryStaff: false }, "empresa-a"),
    ).toBe(false);
  });

  it("refuses an empty company id", () => {
    // `readBusinessIdPayload` already returns null for these, so this is the
    // second line of the same defence: a blank id must never become a room.
    expect(canWatchOperationsOf(staff, "")).toBe(false);
  });

  it("refuses a MASTER asking for an empty company id", () => {
    expect(
      canWatchOperationsOf(
        { role: "MASTER", businessId: null, isDeliveryStaff: true },
        "",
      ),
    ).toBe(false);
  });
});

describe("the room name", () => {
  it("is namespaced per company", () => {
    expect(operationsRoom("empresa-a")).toBe("operations:empresa-a");
  });

  it("is not the company room", () => {
    // They are different rooms with different audiences; a refactor that
    // collapsed them would restore the leak in one line.
    expect(operationsRoom("empresa-a")).not.toBe("business:empresa-a");
  });
});

describe("the company an operations subscription names (RT-1)", () => {
  const BUSINESS = "018f9000-0000-7000-8000-00000000000a";

  it("takes a uuid, trimmed and in the case the rooms are named in", () => {
    expect(readOperationsBusinessId({ businessId: BUSINESS })).toBe(BUSINESS);
    expect(readOperationsBusinessId({ businessId: `  ${BUSINESS.toUpperCase()} ` })).toBe(BUSINESS);
  });

  it("refuses anything that is not a company id", () => {
    // The shared reader took any string up to the 16 KB frame: a MASTER
    // could join operations:<anything>, and every emit publishes the name.
    expect(readOperationsBusinessId({ businessId: "empresa-a" })).toBeNull();
    expect(readOperationsBusinessId({ businessId: "x".repeat(16_000) })).toBeNull();
    expect(readOperationsBusinessId({ businessId: `${BUSINESS}:chat` })).toBeNull();
    expect(readOperationsBusinessId({ businessId: 42 })).toBeNull();
    expect(readOperationsBusinessId({})).toBeNull();
    expect(readOperationsBusinessId(null)).toBeNull();
    expect(readOperationsBusinessId(BUSINESS)).toBeNull();
  });
});
