import { describe, expect, it } from "vitest";

import {
  ROUTE_PLAN_MESSAGES,
  routeDayLabel,
  routePlanIssues,
} from "@/shared/route/route-plan-rules";
import { routeCodeFromSearch } from "@/shared/route/route-rules";
import { dateOnlyFromKey } from "@/shared/time/business-day";

import {
  createRouteSchema,
  listRoutesSchema,
  updateRouteSchema,
} from "@/schemas/route-schema";
import { assignDeliveriesSchema } from "@/schemas/assign-deliveries-schema";

import { assignmentWarnings } from "@/modules/route/usecases/assignment-preview/assignment-warnings";
import { cnhCovers } from "@/shared/route/cnh-coverage";

import type { AssignmentPreview } from "@/modules/route/dtos/route-dto";

/**
 * The rules of a route's plan (decisions 1.3, 1.4, 6.5), as pure functions
 * and as the zod layer every endpoint parses with.
 *
 * The messages are pinned word for word: the web mirrors them
 * (trajetto-ui/src/schemas/create-update-route-schema), and a refusal must
 * read the same whether the browser or the server produced it.
 */
const SP = "America/Sao_Paulo";
const DAY_17 = dateOnlyFromKey("2026-09-17");

const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";
const DELIVERY = "018f0000-0000-7000-8000-0000000000f9";

describe("the plan's window, on the company's clock", () => {
  it("accepts a departure on the route's day and a return after it", () => {
    expect(
      routePlanIssues({
        scheduledDate: DAY_17,
        departure: new Date("2026-09-17T11:00:00.000Z"), // 08:00 in São Paulo
        arrival: new Date("2026-09-17T21:00:00.000Z"),
        timeZone: SP,
      }),
    ).toEqual([]);
  });

  it("reads the evening departure in the company's zone, not in UTC", () => {
    // 22:30 of the 17th in São Paulo is 01:30Z of the 18th. A check in UTC
    // would refuse the evening departure of the route of the 17th.
    expect(
      routePlanIssues({
        scheduledDate: DAY_17,
        departure: new Date("2026-09-18T01:30:00.000Z"),
        arrival: null,
        timeZone: SP,
      }),
    ).toEqual([]);

    // The same instant in Manaus (UTC-4) is 21:30 of the 17th: still the day.
    // In Noronha (UTC-2) it is 23:30 of the 17th.
    expect(
      routePlanIssues({
        scheduledDate: DAY_17,
        departure: new Date("2026-09-18T01:30:00.000Z"),
        arrival: null,
        timeZone: "America/Noronha",
      }),
    ).toEqual([]);
  });

  it("refuses a departure on another day, naming the departure", () => {
    // 22:00 of the 16th in São Paulo.
    expect(
      routePlanIssues({
        scheduledDate: DAY_17,
        departure: new Date("2026-09-17T01:00:00.000Z"),
        arrival: null,
        timeZone: SP,
      }),
    ).toEqual([
      {
        field: "planned_departure_at",
        message: "A saída prevista deve ser no dia da rota.",
      },
    ]);
  });

  it("refuses a return before the departure, naming the return", () => {
    expect(
      routePlanIssues({
        scheduledDate: DAY_17,
        departure: new Date("2026-09-17T15:00:00.000Z"),
        arrival: new Date("2026-09-17T14:59:00.000Z"),
        timeZone: SP,
      }),
    ).toEqual([
      {
        field: "planned_arrival_at",
        message:
          "O retorno previsto deve ser igual ou posterior à saída prevista.",
      },
    ]);
  });

  it("accepts a return equal to the departure, and either end alone", () => {
    const at = new Date("2026-09-17T15:00:00.000Z");

    expect(
      routePlanIssues({
        scheduledDate: DAY_17,
        departure: at,
        arrival: at,
        timeZone: SP,
      }),
    ).toEqual([]);

    // A return alone is not judged against a departure nobody planned.
    expect(
      routePlanIssues({
        scheduledDate: DAY_17,
        departure: null,
        arrival: new Date("2026-09-19T15:00:00.000Z"),
        timeZone: SP,
      }),
    ).toEqual([]);
  });

  it("refuses a return alone before the route's day, read in the company's zone", () => {
    // Red before: with no departure the return was unconstrained, while the
    // web's calendar never offers a day before the route's.
    expect(
      routePlanIssues({
        scheduledDate: DAY_17,
        departure: null,
        arrival: new Date("2026-09-16T18:00:00.000Z"),
        timeZone: SP,
      }),
    ).toEqual([
      {
        field: "planned_arrival_at",
        message: "O retorno previsto não pode ser antes do dia da rota.",
      },
    ]);

    // 01:30Z of the 17th is 22:30 of the 16th in São Paulo: still before.
    expect(
      routePlanIssues({
        scheduledDate: DAY_17,
        departure: null,
        arrival: new Date("2026-09-17T01:30:00.000Z"),
        timeZone: SP,
      }).map((issue) => issue.message),
    ).toEqual([ROUTE_PLAN_MESSAGES.arrivalBeforeDay]);

    // One refusal per field: a return before the departure says only that.
    expect(
      routePlanIssues({
        scheduledDate: DAY_17,
        departure: new Date("2026-09-17T12:00:00.000Z"),
        arrival: new Date("2026-09-16T12:00:00.000Z"),
        timeZone: SP,
      }).map((issue) => issue.message),
    ).toEqual([ROUTE_PLAN_MESSAGES.arrivalBeforeDeparture]);
  });
});

describe("the route's day in a push", () => {
  it("is the civil day, in any process zone", () => {
    // The helper alone; route-release-label.test.ts proves the release push
    // in zones west of UTC, which a UTC CI never is.
    expect(routeDayLabel(DAY_17)).toBe("17/09");
    expect(routeDayLabel(new Date("2026-01-01T00:00:00.000Z"))).toBe("01/01");
  });
});

describe("a search term as a route code (TEST-ROUTE-1)", () => {
  it("reads what people type for a code", () => {
    expect(routeCodeFromSearch("12")).toBe(12);
    expect(routeCodeFromSearch(" 0012 ")).toBe(12);
    expect(routeCodeFromSearch("Rota 12")).toBe(12);
    expect(routeCodeFromSearch("rota12")).toBe(12);
    expect(routeCodeFromSearch("#12")).toBe(12);
    expect(routeCodeFromSearch("999999999")).toBe(999999999);
  });

  it("never turns a long number or an exponent into a code", () => {
    // A pasted NF-e key became 4.4e43 and made Prisma answer 500.
    expect(
      routeCodeFromSearch("35240912345678000190550010000012341000012345"),
    ).toBeNull();
    expect(routeCodeFromSearch("1234567890")).toBeNull();
    expect(routeCodeFromSearch("1e3")).toBeNull();
    expect(routeCodeFromSearch("12.5")).toBeNull();
    expect(routeCodeFromSearch("Zona Sul")).toBeNull();
    expect(routeCodeFromSearch("")).toBeNull();
    expect(routeCodeFromSearch(undefined)).toBeNull();
  });
});

describe("the create schema", () => {
  const base = { driverId: DRIVER, scheduled_date: "2026-09-17" };

  const issuesOf = (result: ReturnType<typeof createRouteSchema.safeParse>) =>
    result.success ? [] : result.error.issues.map((issue) => issue.message);

  it("takes the day as a civil date and the times as instants with offset", () => {
    const parsed = createRouteSchema.parse({
      ...base,
      planned_departure_at: "2026-09-17T08:00:00-03:00",
      planned_arrival_at: "2026-09-17T18:00:00.000Z",
      destination: "CD Cajamar",
    });

    expect(parsed.scheduled_date.toISOString()).toBe(
      "2026-09-17T00:00:00.000Z",
    );
    expect(parsed.planned_departure_at?.toISOString()).toBe(
      "2026-09-17T11:00:00.000Z",
    );
    expect(parsed.destination).toBe("CD Cajamar");
  });

  it("refuses a wall time without an offset (it was read in the server's zone)", () => {
    // Red before: z.coerce.date() took "2026-09-17T08:00" and the container,
    // in UTC, stored 08:00Z — 05:00 in São Paulo.
    expect(
      issuesOf(
        createRouteSchema.safeParse({
          ...base,
          planned_departure_at: "2026-09-17T08:00",
        }),
      ),
    ).toEqual([
      "A saída prevista deve ter data, hora e fuso (ex.: 2026-09-17T08:00:00-03:00).",
    ]);
  });

  it("refuses an instant as the route's day", () => {
    expect(
      issuesOf(
        createRouteSchema.safeParse({
          ...base,
          scheduled_date: "2026-09-17T03:00:00.000Z",
        }),
      ),
    ).toEqual(["A data da rota deve estar no formato AAAA-MM-DD."]);

    expect(
      issuesOf(
        createRouteSchema.safeParse({ ...base, scheduled_date: "2026-02-30" }),
      ),
    ).toEqual(["A data da rota é inválida."]);

    expect(issuesOf(createRouteSchema.safeParse({ driverId: DRIVER }))).toEqual(
      ["A data da rota é obrigatória."],
    );
  });

  it("refuses a return before the departure with the shared message", () => {
    expect(
      issuesOf(
        createRouteSchema.safeParse({
          ...base,
          planned_departure_at: "2026-09-17T15:00:00.000Z",
          planned_arrival_at: "2026-09-17T14:00:00.000Z",
        }),
      ),
    ).toEqual([ROUTE_PLAN_MESSAGES.arrivalBeforeDeparture]);
  });

  it("applies the text rules to the name, as the web always did", () => {
    // Red before: the API had only max(80), while the web refused these.
    expect(
      issuesOf(createRouteSchema.safeParse({ ...base, name: "   " })),
    ).toEqual(["O nome da rota não pode conter apenas espaços."]);
    expect(
      issuesOf(createRouteSchema.safeParse({ ...base, name: "Zona  Sul" })),
    ).toEqual(["O nome da rota não deve conter espaços consecutivos."]);
    expect(
      issuesOf(createRouteSchema.safeParse({ ...base, name: " Zona Sul" })),
    ).toEqual([
      "O nome da rota não pode começar ou terminar com espaço em branco.",
    ]);
  });

  it("applies the same rules and a 160-character cap to the destination", () => {
    expect(
      issuesOf(
        createRouteSchema.safeParse({ ...base, destination: "CD  Cajamar" }),
      ),
    ).toEqual(["O destino não deve conter espaços consecutivos."]);
    expect(
      issuesOf(
        createRouteSchema.safeParse({ ...base, destination: "x".repeat(161) }),
      ),
    ).toEqual(["O destino deve ter no máximo 160 caracteres."]);

    // Empty is "none".
    expect(
      createRouteSchema.parse({ ...base, destination: "" }).destination,
    ).toBeNull();
  });

  it("parses its own output again (Fastify validates, the controller re-parses)", () => {
    const once = createRouteSchema.parse({
      ...base,
      planned_departure_at: "2026-09-17T08:00:00-03:00",
    });

    const twice = createRouteSchema.parse(once);

    expect(twice.scheduled_date.toISOString()).toBe("2026-09-17T00:00:00.000Z");
    expect(twice.planned_departure_at?.toISOString()).toBe(
      "2026-09-17T11:00:00.000Z",
    );
  });
});

describe("the update schema", () => {
  it("clears with null and keeps with absence", () => {
    const parsed = updateRouteSchema.parse({
      planned_departure_at: null,
      destination: "",
    });

    expect(parsed.planned_departure_at).toBeNull();
    expect(parsed.destination).toBeNull();
    expect("planned_arrival_at" in parsed).toBe(false);
  });

  it("checks the window when both ends come in the body", () => {
    const result = updateRouteSchema.safeParse({
      planned_departure_at: "2026-09-17T15:00:00.000Z",
      planned_arrival_at: "2026-09-17T14:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues[0].path).toEqual([
      "planned_arrival_at",
    ]);
  });
});

describe("the list query", () => {
  it("takes the day filter as a civil date", () => {
    const parsed = listRoutesSchema.parse({
      page: "1",
      pageSize: "10",
      scheduled_date: "2026-09-17",
    });

    expect(parsed.scheduled_date?.toISOString()).toBe(
      "2026-09-17T00:00:00.000Z",
    );
  });
});

describe("the assignment schema", () => {
  const base = {
    deliveryIds: [DELIVERY],
    driverId: DRIVER,
    vehicleId: VEHICLE,
  };

  it("still takes the three ids alone (the day defaults on the server)", () => {
    const parsed = assignDeliveriesSchema.parse(base);

    expect(parsed.scheduled_date).toBeUndefined();
    expect(parsed.planned_departure_at).toBeUndefined();
  });

  it("takes the plan of the route it creates, under the same rules", () => {
    const parsed = assignDeliveriesSchema.parse({
      ...base,
      scheduled_date: "2026-09-17",
      destination: "Zona Leste",
      planned_departure_at: "2026-09-17T08:00:00-03:00",
      planned_arrival_at: "2026-09-17T17:00:00-03:00",
    });

    expect(parsed.scheduled_date?.toISOString()).toBe(
      "2026-09-17T00:00:00.000Z",
    );
    expect(parsed.destination).toBe("Zona Leste");

    const refused = assignDeliveriesSchema.safeParse({
      ...base,
      planned_departure_at: "2026-09-17T17:00:00-03:00",
      planned_arrival_at: "2026-09-17T08:00:00-03:00",
    });

    expect(
      refused.success ? [] : refused.error.issues.map((i) => i.message),
    ).toEqual([ROUTE_PLAN_MESSAGES.arrivalBeforeDeparture]);
  });
});

describe("what the assignment dialog is warned about", () => {
  const DAY = new Date("2026-09-17T00:00:00.000Z");
  const ZONE = "America/Sao_Paulo";

  const vehicleOf = (
    overrides: Partial<NonNullable<AssignmentPreview["vehicle"]>> = {},
  ): NonNullable<AssignmentPreview["vehicle"]> => ({
    id: VEHICLE,
    license_plate: "ABC1D23",
    description: "Caminhão",
    status: "ACTIVE",
    responsible: null,
    required_cnh_category: null,
    openServiceOrders: { count: 0, oldest: null },
    lastChecklist: null,
    ...overrides,
  });

  const preview = (
    overrides: Partial<AssignmentPreview> = {},
  ): AssignmentPreview => ({
    driver: {
      id: DRIVER,
      name: "João",
      status: "ACTIVE",
      cnh_category: "E",
      cnh_expires_at: new Date("2030-01-01T00:00:00.000Z"),
    },
    driverRunningRoute: null,
    driverRoutesOnDay: [],
    responsibleVehicles: [],
    vehicle: vehicleOf(),
    vehicleRunningRoute: null,
    vehicleRoutesOnDay: [],
    routesEmptiedBySelection: [],
    ...overrides,
  });

  const options = (extra: { excludeRouteId?: string } = {}) => ({
    driverId: DRIVER,
    day: DAY,
    timeZone: ZONE,
    ...extra,
  });

  const ref = (
    id: string,
    code: number,
    driverName: string | null = "João",
  ) => ({
    id,
    code,
    status: "RELEASED" as const,
    driverName,
  });

  it("says nothing about a free pair", () => {
    expect(assignmentWarnings(preview(), options())).toEqual([]);
  });

  it("names a vehicle whose responsible is somebody else, without blocking", () => {
    const warnings = assignmentWarnings(
      preview({
        vehicle: vehicleOf({
          description: null,
          responsible: { id: "other-driver", name: "Maria" },
        }),
      }),
      options(),
    );

    expect(warnings).toEqual([
      {
        code: "VEHICLE_OTHER_RESPONSIBLE",
        message:
          "O responsável pelo veículo ABC1D23 é Maria. A atribuição continua permitida.",
      },
    ]);
  });

  it("names the routes the pair already has, once each", () => {
    const warnings = assignmentWarnings(
      preview({
        driverRunningRoute: { ...ref("r-9", 9), status: "IN_PROGRESS" },
        driverRoutesOnDay: [ref("r-12", 12)],
        vehicle: vehicleOf({
          description: null,
          status: "IN_ROUTE",
          responsible: { id: DRIVER, name: "João" },
        }),
        vehicleRunningRoute: {
          ...ref("r-7", 7, "Maria"),
          status: "IN_PROGRESS",
        },
        // r-12 is the driver's own, already named above.
        vehicleRoutesOnDay: [
          ref("r-12", 12),
          ref("r-14", 14, "Maria"),
          ref("r-15", 15, "Ana"),
        ],
      }),
      options(),
    );

    expect(warnings.map((warning) => warning.message)).toEqual([
      "João está com a Rota 9 em andamento; uma nova rota só pode sair quando essa terminar.",
      "João já tem a Rota 12 para este dia.",
      "O veículo ABC1D23 está em rota agora (Rota 7, com Maria); ele só pode sair de novo quando essa rota terminar.",
      "O veículo ABC1D23 já está nas Rotas 14 e 15 deste dia.",
    ]);
  });

  it("does not warn a route being edited about itself", () => {
    const warnings = assignmentWarnings(
      preview({
        driverRoutesOnDay: [ref("editing", 3)],
        vehicleRoutesOnDay: [ref("editing", 3)],
      }),
      options({ excludeRouteId: "editing" }),
    );

    expect(warnings).toEqual([]);
  });

  it("does not warn about the route the selection is leaving (and cancelling)", () => {
    // Red before: the dialog warned "João já tem a Rota 5 para este dia"
    // about the released route the assignment itself empties and cancels.
    const warnings = assignmentWarnings(
      preview({
        driverRoutesOnDay: [ref("r-5", 5), ref("r-6", 6)],
        vehicleRoutesOnDay: [ref("r-5", 5)],
        routesEmptiedBySelection: ["r-5"],
      }),
      options(),
    );

    expect(warnings.map((warning) => warning.message)).toEqual([
      "João já tem a Rota 6 para este dia.",
    ]);
  });

  it("says a vehicle out of operation cannot take the route", () => {
    const warnings = assignmentWarnings(
      preview({ vehicle: vehicleOf({ description: null, status: "BLOCKED" }) }),
      options(),
    );

    expect(warnings.map((warning) => warning.code)).toEqual([
      "VEHICLE_OUT_OF_OPERATION",
    ]);
  });

  describe("the fleet's own facts (decision 8.5)", () => {
    it("warns about a CNH that expired before the route's day, not on it", () => {
      const expiredBefore = assignmentWarnings(
        preview({
          driver: {
            ...preview().driver!,
            cnh_expires_at: new Date("2026-09-16T00:00:00.000Z"),
          },
        }),
        options(),
      );

      expect(expiredBefore).toEqual([
        {
          code: "DRIVER_CNH_EXPIRED",
          message: "A CNH de João venceu em 16/09/2026.",
        },
      ]);

      // Valid THROUGH its last day.
      const lastDay = assignmentWarnings(
        preview({
          driver: { ...preview().driver!, cnh_expires_at: DAY },
        }),
        options(),
      );

      expect(lastDay).toEqual([]);
    });

    it("warns when the CNH category does not cover the vehicle type's, or is unknown", () => {
      const incompatible = assignmentWarnings(
        preview({
          driver: { ...preview().driver!, cnh_category: "B" },
          vehicle: vehicleOf({ required_cnh_category: "C" }),
        }),
        options(),
      );

      expect(incompatible).toEqual([
        {
          code: "DRIVER_CNH_INCOMPATIBLE",
          message:
            "O veículo ABC1D23 exige CNH categoria C, e a CNH de João é categoria B.",
        },
      ]);

      const unknown = assignmentWarnings(
        preview({
          driver: { ...preview().driver!, cnh_category: null },
          vehicle: vehicleOf({ required_cnh_category: "D" }),
        }),
        options(),
      );

      expect(unknown.map((warning) => warning.code)).toEqual([
        "DRIVER_CNH_CATEGORY_UNKNOWN",
      ]);

      // A higher rung drives the lower one: E covers C.
      expect(
        assignmentWarnings(
          preview({ vehicle: vehicleOf({ required_cnh_category: "C" }) }),
          options(),
        ),
      ).toEqual([]);
    });

    it("warns about open service orders, dated on the company's calendar", () => {
      const one = assignmentWarnings(
        preview({
          vehicle: vehicleOf({
            // 01:30Z of the 15th is still the 14th in São Paulo.
            openServiceOrders: {
              count: 1,
              oldest: new Date("2026-09-15T01:30:00.000Z"),
            },
          }),
        }),
        options(),
      );

      expect(one).toEqual([
        {
          code: "VEHICLE_OPEN_SERVICE_ORDER",
          message:
            "O veículo ABC1D23 tem 1 ordem de serviço aberta desde 14/09/2026.",
        },
      ]);

      const several = assignmentWarnings(
        preview({
          vehicle: vehicleOf({
            openServiceOrders: {
              count: 3,
              oldest: new Date("2026-09-10T12:00:00.000Z"),
            },
          }),
        }),
        options(),
      );

      expect(several[0].message).toBe(
        "O veículo ABC1D23 tem 3 ordens de serviço abertas, a mais antiga desde 10/09/2026.",
      );
    });

    it("says nothing about orders it did not read (a company without Frotas)", () => {
      expect(
        assignmentWarnings(
          preview({ vehicle: vehicleOf({ openServiceOrders: null }) }),
          options(),
        ),
      ).toEqual([]);
    });

    it("warns only when the LAST checklist was rejected", () => {
      const rejected = assignmentWarnings(
        preview({
          vehicle: vehicleOf({
            lastChecklist: {
              overall_condition: "rejected",
              checklist_date: new Date("2026-09-16T15:00:00.000Z"),
            },
          }),
        }),
        options(),
      );

      expect(rejected).toEqual([
        {
          code: "VEHICLE_CHECKLIST_REJECTED",
          message:
            "O último checklist do veículo ABC1D23, de 16/09/2026, foi reprovado.",
        },
      ]);

      expect(
        assignmentWarnings(
          preview({
            vehicle: vehicleOf({
              lastChecklist: {
                overall_condition: "approved_with_restrictions",
                checklist_date: new Date("2026-09-16T15:00:00.000Z"),
              },
            }),
          }),
          options(),
        ),
      ).toEqual([]);
    });
  });
});

describe("which CNH category drives which vehicle (decision 8.5)", () => {
  it("climbs the B-C-D-E ladder and keeps A apart", () => {
    expect(cnhCovers("B", "B")).toBe(true);
    expect(cnhCovers("B", "C")).toBe(false);
    expect(cnhCovers("D", "C")).toBe(true);
    expect(cnhCovers("E", "D")).toBe(true);
    expect(cnhCovers("C", "E")).toBe(false);

    expect(cnhCovers("E", "A")).toBe(false);
    expect(cnhCovers("A", "B")).toBe(false);
    expect(cnhCovers("AB", "A")).toBe(true);
    expect(cnhCovers("AB", "B")).toBe(true);
    expect(cnhCovers("AD", "AC")).toBe(true);
    expect(cnhCovers("AC", "AD")).toBe(false);
    expect(cnhCovers("D", "AB")).toBe(false);

    // A type that asks for nothing.
    expect(cnhCovers("B", null)).toBe(true);
  });
});
