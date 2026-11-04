import { describe, expect, it } from "vitest";

import {
  renderRouteCancelledPush,
  renderRouteLeftOpenInApp,
  renderRoutePlanChangedPush,
  renderRouteRecordBranchMissingActivity,
  renderRouteRecordBranchMissingInApp,
  renderRouteReleasedPush,
  routeCancelledPolicy,
  routeLeftOpenPolicy,
  routePlanChangedPolicy,
  routeRecordBranchMissingPolicy,
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
    // absent: the board shows them and the trail records them. A route left
    // open (K11) is the one that goes to the admins, not the driver.
    expect(
      Object.keys(notificationPolicies).filter((topic) =>
        topic.startsWith("route."),
      ),
    ).toEqual([
      "route.released",
      "route.cancelled",
      "route.plan_changed",
      "route.left_open",
      "route.record_branch_missing",
    ]);
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
    expect(push.data).toEqual({
      url: "/route",
      routeId: changed.routeId,
      planVersion: 3,
    });
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

/**
 * Plan of 02/11/2026, K11 (decision D26): a route left "Em andamento" goes
 * to the company's admins — the people who can close it — once, in the
 * inbox, with a link to the route page where "Encerrar com pendências" is.
 */
describe("route.left_open", () => {
  const leftOpen = {
    routeId: "018f0000-0000-7000-8000-0000000000r9",
    businessId: "018f0000-0000-7000-8000-00000000000a",
    code: 1,
    routeName: null,
    driverName: "João",
    startedAt: "2026-10-30T17:57:00.000Z",
    sinceLabel: "30/10 às 14:57",
    openDays: 3,
  };

  it("is registered and goes to the company's admins, in the inbox, mandatory", async () => {
    expect(notificationPolicies["route.left_open"]).toBe(routeLeftOpenPolicy);
    expect(routeLeftOpenPolicy.mandatory).toBe(true);
    expect(routeLeftOpenPolicy.renderPush).toBeUndefined();

    const asked: string[] = [];
    const admins = [{ id: "admin-1" }] as User[];

    expect(
      await routeLeftOpenPolicy.resolveRecipients(leftOpen, {
        userRepository: {
          findBusinessAdminsByBusinessId: async (businessId: string) => {
            asked.push(businessId);
            return admins;
          },
        },
      } as never),
    ).toBe(admins);
    expect(asked).toEqual([leftOpen.businessId]);
  });

  it("says since when, with whom, what it blocks, and links to the route", () => {
    const rendered = renderRouteLeftOpenInApp(leftOpen, {
      baseUrl: "https://app.exemplo.com.br",
    });

    expect(rendered).toEqual({
      type: "delivery",
      title: "Rota esquecida em andamento",
      message:
        "Rota 1 está em andamento há 3 dias com João (desde 30/10 às 14:57). " +
        "Enquanto ela não for concluída ou cancelada, o motorista e o veículo não saem em outra rota. " +
        "Conclua, cancele ou use Encerrar com pendências.",
      link: `https://app.exemplo.com.br/dashboard/routes/${leftOpen.routeId}`,
      entityId: leftOpen.routeId,
    });

    expect(
      renderRouteLeftOpenInApp(
        { ...leftOpen, openDays: 0, driverName: null, routeName: "Zona Sul" },
        { baseUrl: "" },
      ).message,
    ).toContain(
      "Rota 1 (Zona Sul) está em andamento há mais de 16 horas (desde",
    );
  });
});

/**
 * A driver's route record refused because no active branch files it (wave
 * 3.7; the product principle: never block the driver over an admin's data
 * gap, show it to the dispatcher). The app lets the route go on; this tells
 * the people who run the deliveries — once per route and phase, the outbox
 * key — what to fix and that the driver resends with "Tentar de novo".
 */
describe("route.record_branch_missing", () => {
  const missing = {
    routeId: "018f0000-0000-7000-8000-0000000000r7",
    businessId: "018f0000-0000-7000-8000-00000000000a",
    code: 42,
    record: "CHECKLIST" as const,
    phase: "ROUTE_START" as const,
    driverName: "Rita Barros",
    vehiclePlate: "RBR4E21",
  };

  it("is registered, mandatory, in the inbox of the delivery operators", async () => {
    expect(notificationPolicies["route.record_branch_missing"]).toBe(
      routeRecordBranchMissingPolicy,
    );
    expect(routeRecordBranchMissingPolicy.mandatory).toBe(true);
    expect(routeRecordBranchMissingPolicy.renderWhatsApp).toBeUndefined();

    const asked: string[] = [];
    const operators = [{ id: "operator-1" }] as User[];

    expect(
      await routeRecordBranchMissingPolicy.resolveRecipients(missing, {
        userRepository: {
          findDeliveryOperators: async (businessId: string) => {
            asked.push(businessId);
            return operators;
          },
        },
      } as never),
    ).toBe(operators);
    expect(asked).toEqual([missing.businessId]);
  });

  it("names the record, the driver, the route and the plate, says what to fix and links to the route", () => {
    expect(
      renderRouteRecordBranchMissingInApp(missing, {
        baseUrl: "https://app.exemplo.com.br",
      }),
    ).toEqual({
      type: "delivery",
      title: "Checklist do motorista recusado",
      message:
        "Checklist de saída do motorista Rita Barros recusado: a rota 42 não tem filial ativa (veículo RBR4E21). " +
        "Defina uma filial ativa no veículo ou no motorista; depois, o motorista reenvia em Tentar de novo. A rota segue sem o checklist.",
      link: `https://app.exemplo.com.br/dashboard/routes/${missing.routeId}`,
      entityId: missing.routeId,
    });

    const arrival = renderRouteRecordBranchMissingInApp(
      { ...missing, phase: "ROUTE_END", driverName: null },
      { baseUrl: "" },
    );
    expect(arrival.message).toContain(
      "Checklist de chegada do motorista recusado: a rota 42 não tem filial ativa (veículo RBR4E21).",
    );

    const fuel = renderRouteRecordBranchMissingInApp(
      { ...missing, record: "FUEL", phase: null },
      { baseUrl: "" },
    );
    expect(fuel.title).toBe("Abastecimento do motorista recusado");
    expect(fuel.message).toBe(
      "Abastecimento do motorista Rita Barros recusado: a rota 42 não tem filial ativa (veículo RBR4E21). " +
        "Defina uma filial ativa no veículo ou no motorista; depois, o motorista reenvia em Tentar de novo.",
    );
  });

  it("leaves one entry in the route's trail, from the catalog", () => {
    expect(renderRouteRecordBranchMissingActivity(missing)).toEqual({
      type: "Rota",
      action: "update",
      entityId: missing.routeId,
      description:
        "Checklist de saída do motorista Rita Barros recusado: a rota 42 não tem filial ativa (veículo RBR4E21).",
      status: "Pendente",
    });
  });
});
