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
