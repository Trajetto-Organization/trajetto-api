import { describe, expect, it } from "vitest";

import {
  renderFineCreatedActivity,
  renderFineCreatedInApp,
  renderFineCreatedWhatsApp,
} from "@/shared/notifications/policies/fine-created-policy";

import { formatCurrency } from "@/shared/utils/format-values";
import type { FineCreatedPayload } from "@/shared/notifications/notification-types";

const payload = (): FineCreatedPayload => ({
  fineId: "fine-1",
  businessId: "business-1",
  amount: 293.47,
  points: 5,
  violationDate: "2026-08-10T12:00:00.000Z",
  location: "Av. Brasil, 1000",
  observation: "Radar móvel",
  vehiclePlate: "ABC1D23",
  driverName: "João Motorista",
  branchName: "Filial Centro",
  violationCode: "745-50",
  actor: {
    id: "user-1",
    name: "Maria Gestora",
    email: "maria@empresa.com",
    role: "BUSINESS_ADMIN",
  },
});

describe("fine.created in-app render", () => {
  it("says what happened, to which vehicle, for how much", () => {
    const rendered = renderFineCreatedInApp(payload(), {
      baseUrl: "https://app.trajetto.com",
    });

    expect(rendered.title).toBe("Nova Multa Registrada");
    expect(rendered.message).toContain(formatCurrency(293.47));
    expect(rendered.message).toContain("ABC1D23");
    expect(rendered.entityId).toBe("fine-1");
  });

  /**
   * The link lands on the fine already filtered by id — it is what makes the
   * notification actionable instead of a dead end on a paginated list.
   */
  it("links straight to the fine", () => {
    const rendered = renderFineCreatedInApp(payload(), {
      baseUrl: "https://app.trajetto.com",
    });

    expect(rendered.link).toBe(
      "https://app.trajetto.com/dashboard/fine?search=fine-1&page=1",
    );
  });
});

/**
 * Plan of 02/11/2026 (B1): trajetto_multa_registrada, eleven parameters in
 * the approved order. What is missing goes as null, and the registry puts
 * the variable's fallback there — never a blank Meta would refuse.
 */
describe("fine.created WhatsApp render", () => {
  /** The Intl currency carries a non-breaking space the registry flattens. */
  const params = (data: FineCreatedPayload) =>
    renderFineCreatedWhatsApp(data).parameters.map((value) =>
      typeof value === "string" ? value.replace(/\s/g, " ") : value,
    );

  it("names its template, with every field in the approved order", () => {
    const rendered = renderFineCreatedWhatsApp({
      ...payload(),
      violationDescription: "Transitar em velocidade superior à máxima",
      dueDate: "2026-09-10T12:00:00.000Z",
      timeZone: "America/Sao_Paulo",
    });

    expect(rendered.template).toBe("trajetto_multa_registrada");
    expect(
      rendered.parameters.map((value) =>
        typeof value === "string" ? value.replace(/\s/g, " ") : value,
      ),
    ).toEqual([
      "ABC1D23",
      "João Motorista",
      "Filial Centro",
      "745-50 – Transitar em velocidade superior à máxima",
      "10/08/2026",
      "Av. Brasil, 1000",
      "5",
      "R$ 293,47",
      "10/09/2026",
      "Radar móvel",
      "Maria Gestora (maria@empresa.com)",
    ]);
  });

  it("names the platform, never the master, when a MASTER registered the fine", () => {
    const data = payload();
    data.actor = { ...data.actor, role: "MASTER" };

    const values = params(data);

    expect(values[10]).toBe("Suporte Trajetto");
    expect(JSON.stringify(values)).not.toContain("Maria Gestora");
    expect(JSON.stringify(values)).not.toContain("maria@empresa.com");
  });

  it("prints zero points: an infraction without points is still a fact", () => {
    expect(params({ ...payload(), points: 0 })[6]).toBe("0");
  });

  it("leaves what is missing to the fallbacks instead of printing blanks", () => {
    const values = params({
      ...payload(),
      points: null,
      location: null,
      observation: null,
    });

    expect(values[5]).toBeNull();
    expect(values[6]).toBeNull();
    expect(values[9]).toBeNull();
    // An event published before the new fields: the code alone, no due day.
    expect(values[3]).toBe("745-50");
    expect(values[8]).toBeNull();
  });
});

describe("fine.created activity render", () => {
  it("records driver, violation, vehicle and id in one line", () => {
    const activity = renderFineCreatedActivity(payload());

    expect(activity.type).toBe("Multa");
    expect(activity.action).toBe("create");
    expect(activity.status).toBe("Pendente");
    expect(activity.entityId).toBe("fine-1");

    expect(activity.description).toContain("João Motorista");
    expect(activity.description).toContain("745-50");
    expect(activity.description).toContain("ABC1D23");
    expect(activity.description).not.toContain("\n");
  });
});

/**
 * The infraction day in the company's zone (decision 1.1). The WhatsApp line
 * used the process's zone: UTC in the container, so a fine registered for the
 * evening of the 17th in Manaus went out as the 18th.
 */
describe("fine.created violation date", () => {
  const dayOf = (data: FineCreatedPayload) =>
    renderFineCreatedWhatsApp(data).parameters[4];

  it("reads an instant on the company's day", () => {
    // 03:30 UTC on the 18th = 23:30 on the 17th in Manaus, 00:30 on the 18th
    // in São Paulo: wrong on a UTC server and on a São Paulo one.
    expect(
      dayOf({
        ...payload(),
        violationDate: "2026-09-18T03:30:00.000Z",
        timeZone: "America/Manaus",
      }),
    ).toBe("17/09/2026");
  });

  it("keeps a date-only value on the day it names", () => {
    expect(
      dayOf({
        ...payload(),
        violationDate: "2026-09-17T00:00:00.000Z",
        timeZone: "America/Manaus",
      }),
    ).toBe("17/09/2026");
  });

  it("falls back to the default zone for an event published without one", () => {
    // 23:30 on the 17th in São Paulo.
    expect(
      dayOf({ ...payload(), violationDate: "2026-09-18T02:30:00.000Z" }),
    ).toBe("17/09/2026");
  });
});
