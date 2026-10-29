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

describe("fine.created WhatsApp render", () => {
  it("identifies a business actor to the admins reading it", () => {
    const text = renderFineCreatedWhatsApp(payload());

    expect(text).toContain("Maria Gestora");
    expect(text).toContain("maria@empresa.com");
    expect(text).toContain("ABC1D23");
    expect(text).toContain("fine-1");
  });

  /**
   * A MASTER registering a fine for a client company is back office — their
   * name would only confuse the company admins receiving the alert.
   */
  it("omits the actor when a MASTER registered the fine", () => {
    const data = payload();
    data.actor.role = "MASTER";

    const text = renderFineCreatedWhatsApp(data);

    expect(text).not.toContain("Maria Gestora");
    expect(text).not.toContain("maria@empresa.com");
    expect(text).toContain("ABC1D23");
  });

  /**
   * WhatsApp bolds from one `*` to the next. The points and observation
   * lines opened one and never closed it, so every line after them came out
   * bold (or, with an odd count, the asterisks showed as text).
   */
  it("closes the bold of every line it opens", () => {
    const lines = renderFineCreatedWhatsApp(payload()).split("\n");

    for (const line of lines) {
      const stars = (line.match(/\*/g) ?? []).length;

      expect(stars % 2, line).toBe(0);
    }

    expect(lines).toContain("Pontos na carteira: *5*");
    expect(lines).toContain("Observação: *Radar móvel*");
  });

  it("prints zero points: an infraction without points is still a fact", () => {
    const data = payload();
    data.points = 0;

    expect(renderFineCreatedWhatsApp(data)).toContain(
      "Pontos na carteira: *0*",
    );
  });

  it("drops optional lines instead of printing blanks", () => {
    const data = payload();
    data.location = null;
    data.observation = null;
    data.points = null;

    const text = renderFineCreatedWhatsApp(data);

    expect(text).not.toContain("Local:");
    expect(text).not.toContain("Observação:");
    expect(text).not.toContain("Pontos na carteira:");
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
  const lineOf = (text: string) =>
    text.split("\n").find((line) => line.startsWith("Data da infração:"));

  it("reads an instant on the company's day", () => {
    // 03:30 UTC on the 18th = 23:30 on the 17th in Manaus, 00:30 on the 18th
    // in São Paulo: wrong on a UTC server and on a São Paulo one.
    const text = renderFineCreatedWhatsApp({
      ...payload(),
      violationDate: "2026-09-18T03:30:00.000Z",
      timeZone: "America/Manaus",
    });

    expect(lineOf(text)).toBe("Data da infração: *17/09/2026*");
  });

  it("keeps a date-only value on the day it names", () => {
    const text = renderFineCreatedWhatsApp({
      ...payload(),
      violationDate: "2026-09-17T00:00:00.000Z",
      timeZone: "America/Manaus",
    });

    expect(lineOf(text)).toBe("Data da infração: *17/09/2026*");
  });

  it("falls back to the default zone for an event published without one", () => {
    const text = renderFineCreatedWhatsApp({
      ...payload(),
      violationDate: "2026-09-18T02:30:00.000Z",
    });

    // 23:30 on the 17th in São Paulo.
    expect(lineOf(text)).toBe("Data da infração: *17/09/2026*");
  });
});
