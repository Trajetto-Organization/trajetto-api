import { describe, expect, it } from "vitest";

import {
  OPEN_STOP_STATUSES,
  ROUTE_STATUS_LABELS,
  ROUTE_STOP_STATUS_LABELS,
  canTransitionRoute,
  canTransitionStop,
  canUnreleaseRoute,
  isTerminalRouteStatus,
  routeCodeFromSearch,
  stopOutcomeForDelivery,
  type RouteStatus,
  type RouteStopStatus,
} from "@/shared/route/route-rules";

/**
 * The route and stop state machines as whole tables (mutation run 06/10:
 * single entries of ROUTE_TRANSITIONS / ROUTE_STOP_TRANSITIONS and the labels
 * could change with every test green). Every pair is asserted with its
 * message.
 */

const ROUTE: RouteStatus[] = ["PLANNED", "RELEASED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
const ROUTE_ALLOWED: Record<RouteStatus, RouteStatus[]> = {
  PLANNED: ["RELEASED", "CANCELLED"],
  RELEASED: ["PLANNED", "IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

const STOP: RouteStopStatus[] = ["PENDING", "ARRIVED", "COMPLETED", "FAILED", "CANCELLED"];
const STOP_ALLOWED: Record<RouteStopStatus, RouteStopStatus[]> = {
  PENDING: ["ARRIVED", "COMPLETED", "FAILED", "CANCELLED"],
  ARRIVED: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

describe("labels", () => {
  it("names every route and stop status", () => {
    expect(ROUTE_STATUS_LABELS).toEqual({
      PLANNED: "Planejada",
      RELEASED: "Liberada",
      IN_PROGRESS: "Em andamento",
      COMPLETED: "Concluída",
      CANCELLED: "Cancelada",
    });
    expect(ROUTE_STOP_STATUS_LABELS).toEqual({
      PENDING: "Pendente",
      ARRIVED: "No local",
      COMPLETED: "Concluída",
      FAILED: "Insucesso",
      CANCELLED: "Cancelada",
    });
  });
});

describe("canTransitionRoute, every pair", () => {
  for (const from of ROUTE) {
    for (const to of ROUTE) {
      const verdict =
        from === to
          ? { allowed: false, reason: `A rota já está "${ROUTE_STATUS_LABELS[from]}".` }
          : ROUTE_ALLOWED[from].includes(to)
            ? { allowed: true, reason: null }
            : {
                allowed: false,
                reason: `Não é possível mudar a rota de "${ROUTE_STATUS_LABELS[from]}" para "${ROUTE_STATUS_LABELS[to]}".`,
              };

      it(`${from} → ${to}`, () => {
        expect(canTransitionRoute(from, to)).toEqual(verdict);
      });
    }
  }

  it("calls only COMPLETED and CANCELLED terminal", () => {
    expect(ROUTE.filter(isTerminalRouteStatus)).toEqual(["COMPLETED", "CANCELLED"]);
  });
});

describe("canTransitionStop, every pair", () => {
  for (const from of STOP) {
    for (const to of STOP) {
      const verdict =
        from === to
          ? { allowed: false, reason: `A parada já está "${ROUTE_STOP_STATUS_LABELS[from]}".` }
          : STOP_ALLOWED[from].includes(to)
            ? { allowed: true, reason: null }
            : {
                allowed: false,
                reason: `Não é possível mudar a parada de "${ROUTE_STOP_STATUS_LABELS[from]}" para "${ROUTE_STOP_STATUS_LABELS[to]}".`,
              };

      it(`${from} → ${to}`, () => {
        expect(canTransitionStop(from, to)).toEqual(verdict);
      });
    }
  }
});

describe("other route rules", () => {
  it("refuses to unrelease a worked route with the full sentence", () => {
    expect(canUnreleaseRoute(["PENDING", "ARRIVED"])).toEqual({
      allowed: false,
      reason:
        "A rota já começou a ser executada e não pode voltar ao planejamento. Cancele-a se precisar refazê-la.",
    });
  });

  it("reads no code from an absent term", () => {
    expect(routeCodeFromSearch(undefined)).toBeNull();
    expect(routeCodeFromSearch(null)).toBeNull();
  });

  it("applies an outcome only from the open stop statuses", () => {
    expect(OPEN_STOP_STATUSES).toEqual(["PENDING", "ARRIVED"]);
    expect(stopOutcomeForDelivery("DELIVERED", new Date(0))?.from).toEqual(["PENDING", "ARRIVED"]);
  });
});
