import { describe, expect, it } from "vitest";

import {
  renderRouteCancelledPush,
  renderRoutePlanChangedPush,
  renderRouteReleasedPush,
  routeCancelledPolicy,
  routePlanChangedPolicy,
  routeReleasedPolicy,
} from "@/shared/notifications/policies/route-policies";

import { notificationPolicies } from "@/shared/notifications/notification-policy";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { User } from "@/modules/user/dtos/user-dto";
import type {
  RouteCancelledPayload,
  RouteReleasedPayload,
} from "@/shared/notifications/notification-types";

/**
 * What the driver's lock screen actually says.
 *
 * These renders are the last thing between a database row and a person who is
 * driving, and they run on a replica seconds after the event, from the payload
 * alone. So they are pure, and so are these tests.
 */
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a2";

function released(
  overrides: Partial<RouteReleasedPayload> = {},
): RouteReleasedPayload {
  return {
    routeId: "018f0000-0000-7000-8000-0000000000r1",
    businessId: "018f0000-0000-7000-8000-00000000000a",
    driverUserId: DRIVER_USER,
    code: 42,
    routeName: null,
    stopCount: 8,
    scheduledLabel: "16/09",
    ...overrides,
  };
}

function cancelled(
  overrides: Partial<RouteCancelledPayload> = {},
): RouteCancelledPayload {
  return {
    routeId: "018f0000-0000-7000-8000-0000000000r1",
    businessId: "018f0000-0000-7000-8000-00000000000a",
    driverUserId: DRIVER_USER,
    code: 42,
    routeName: null,
    reason: "Caminhão quebrou",
    hadDeparted: true,
    ...overrides,
  };
}

function userRepositoryWith(user: User | null): IUserRepository {
  return {
    findUserById: async () => user,
  } as unknown as IUserRepository;
}

describe("the release push", () => {
  it("names the route by its number when it has no name", () => {
    // The code is what everybody quotes on the phone; the name is optional and
    // most dispatchers do not type one.
    const push = renderRouteReleasedPush(released());

    expect(push.body).toContain("Rota 42");
    expect(push.body).toContain("8 paradas");
    expect(push.body).toContain("16/09");
  });

  it("uses the dispatcher's name when there is one, keeping the number", () => {
    const push = renderRouteReleasedPush(
      released({ routeName: "Zona Sul — manhã" }),
    );

    // Both, because the driver reads the name and the dispatcher on the phone
    // says the number.
    expect(push.body).toContain("Zona Sul — manhã");
    expect(push.body).toContain("rota 42");
  });

  it("says “1 parada”, not “1 paradas”", () => {
    const body = renderRouteReleasedPush(released({ stopCount: 1 })).body;

    expect(body).toContain("1 parada ");
    expect(body).not.toContain("1 paradas");
  });

  it("opens the route screen rather than the notification feed", () => {
    // The driver taps this to start working, not to read about it.
    expect(renderRouteReleasedPush(released()).data).toEqual({ url: "/route" });
  });
});

describe("the cancellation push", () => {
  it("reads urgently when the driver is already on the street", () => {
    const push = renderRouteCancelledPush(cancelled({ hadDeparted: true }));

    expect(push.title).toContain("⛔");
    expect(push.body).toContain("Caminhão quebrou");
  });

  it("reads calmly when nothing had left the yard", () => {
    // Same fact, different urgency: one of these interrupts someone at an
    // address, the other reaches someone having coffee.
    const push = renderRouteCancelledPush(cancelled({ hadDeparted: false }));

    expect(push.title).not.toContain("⛔");
    expect(push.title).toContain("antes da saída");
  });

  it("always carries the reason, because that is what the driver asks next", () => {
    const push = renderRouteCancelledPush(
      cancelled({ reason: "Cliente cancelou o pedido" }),
    );

    expect(push.body).toContain("Cliente cancelou o pedido");
  });
});

describe("who hears it", () => {
  it("resolves to the route's own driver", async () => {
    const user = { id: DRIVER_USER } as User;

    const recipients = await routeReleasedPolicy.resolveRecipients(released(), {
      userRepository: userRepositoryWith(user),
    });

    expect(recipients).toEqual([user]);
  });

  it("resolves to nobody when the driver has no login", async () => {
    // Registering drivers before handing out phones is a real operation. It
    // must be an empty recipient list, not an error in the pipeline.
    const recipients = await routeReleasedPolicy.resolveRecipients(
      released({ driverUserId: null }),
      { userRepository: userRepositoryWith(null) },
    );

    expect(recipients).toEqual([]);
  });

  it("resolves to nobody when the user was deleted since the event", async () => {
    const recipients = await routeCancelledPolicy.resolveRecipients(
      cancelled(),
      { userRepository: userRepositoryWith(null) },
    );

    expect(recipients).toEqual([]);
  });

  it("reaches a driver who muted task notifications", () => {
    // Preferences control noise, not the company telling someone their day
    // changed. A driver who silenced tasks still has to hear that the route
    // they are driving was called off.
    expect(routeReleasedPolicy.mandatory).toBe(true);
    expect(routeCancelledPolicy.mandatory).toBe(true);
  });
});

describe("the shape of the two topics", () => {
  it("is push-only: no feed row, no e-mail, no WhatsApp", () => {
    // The route screen IS the in-app surface. A notification row per release
    // would duplicate the thing it points at.
    for (const policy of [routeReleasedPolicy, routeCancelledPolicy]) {
      expect(policy.renderPush).toBeDefined();
      expect(policy.renderInApp).toBeUndefined();
      expect(policy.renderWhatsApp).toBeUndefined();
      expect(policy.renderActivity).toBeUndefined();
    }
  });

  it("registers exactly these route topics and no more", () => {
    // Publishing a topic with no entry fails visibly in the pipeline, so the
    // registry is the real list. A departure and a completion are deliberately
    // absent: the board shows them and the trail records them.
    expect(
      Object.keys(notificationPolicies).filter((topic) =>
        topic.startsWith("route."),
      ),
    ).toEqual(["route.released", "route.cancelled", "route.plan_changed"]);
  });
});

/**
 * Decision 14.7 (design §7.2): the dispatcher changed the stops of a route
 * already released to the driver. The socket reaches an open app; this push
 * reaches a phone in a pocket, and opens the day's list.
 */
describe("the plan-changed push", () => {
  const changed = {
    routeId: "018f0000-0000-7000-8000-0000000000r1",
    businessId: "018f0000-0000-7000-8000-00000000000a",
    driverUserId: DRIVER_USER,
    code: 42,
    planVersion: 3,
  };

  it("names the route and opens the day's list", () => {
    const push = renderRoutePlanChangedPush(changed);

    expect(push.title).toBe("Sua rota foi alterada");
    expect(push.body).toContain("rota 42");
    expect(push.data).toEqual({ url: "/route", routeId: changed.routeId, planVersion: 3 });
  });

  it("reaches the route's driver, push-only and mandatory", async () => {
    expect(routePlanChangedPolicy.mandatory).toBe(true);
    expect(routePlanChangedPolicy.renderInApp).toBeUndefined();
    expect(
      await routePlanChangedPolicy.resolveRecipients(changed, {
        userRepository: userRepositoryWith({ id: DRIVER_USER } as User),
      } as never),
    ).toEqual([{ id: DRIVER_USER }]);
  });
});
