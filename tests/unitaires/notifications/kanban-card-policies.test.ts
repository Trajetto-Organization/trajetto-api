import { describe, expect, it } from "vitest";

import {
  renderKanbanCardCreatedActivity,
  renderKanbanCardCreatedInApp,
  renderKanbanCardCreatedWhatsApp,
  renderKanbanCardUpdatedInApp,
  renderKanbanCardUpdatedWhatsApp,
} from "@/shared/notifications/policies/kanban-card-policies";

import type { KanbanCardCreatedPayload } from "@/shared/notifications/notification-types";

const payload = (): KanbanCardCreatedPayload => ({
  cardId: "card-1",
  businessId: "biz-1",
  title: "Manutenção ABC1D23",
  description: "Troca de pastilhas",
  priority: "high",
  dueDate: "2026-08-22T12:00:00.000Z",
  isCompleted: false,
  assignedUserId: "user-9",
  fromServiceOrder: false,
});

const ctx = { baseUrl: "https://app.trajetto.com" };

describe("kanban card renders", () => {
  it("links each role to its own kanban route", () => {
    expect(
      renderKanbanCardCreatedInApp(payload(), ctx, {
        id: "user-9",
        role: "BUSINESS_USER",
        driverId: "drv-1",
      }).link,
    ).toBe("https://app.trajetto.com/driver/kanban?search=card-1&page=1");

    expect(
      renderKanbanCardCreatedInApp(payload(), ctx, {
        id: "user-9",
        role: "MASTER",
        driverId: null,
      }).link,
    ).toBe("https://app.trajetto.com/admin/kanban?search=card-1&page=1");
  });

  it("translates the priority into the labelled emoji, without bold", () => {
    expect(renderKanbanCardCreatedWhatsApp(payload())?.parameters[1]).toBe(
      "🔴 Alta",
    );

    expect(
      renderKanbanCardCreatedWhatsApp({ ...payload(), priority: "urgent" })
        ?.parameters[1],
    ).toBe("🆘 Urgente");
  });

  /**
   * Creation and update say different things — being handed a brand-new card
   * is not the same as inheriting one mid-flight, and the person reading the
   * message should know which happened. Plan of 02/11/2026 (B1): two
   * templates, with the title instead of the card's UUID.
   */
  it("keeps the created and updated templates distinct", () => {
    expect(renderKanbanCardCreatedWhatsApp(payload())).toEqual({
      template: "trajetto_kanban_card_criado",
      parameters: [
        "Manutenção ABC1D23",
        "🔴 Alta",
        "22/08/2026",
        "Troca de pastilhas",
      ],
    });

    expect(renderKanbanCardUpdatedWhatsApp(payload()).template).toBe(
      "trajetto_kanban_card_atualizado",
    );

    expect(
      renderKanbanCardUpdatedInApp(payload(), ctx, {
        id: "user-9",
        role: "BUSINESS_ADMIN",
        driverId: null,
      }).title,
    ).toBe("Card Atualizado e Atribuído");
  });

  it("joins the description's lines with a middle dot", () => {
    expect(
      renderKanbanCardCreatedWhatsApp({
        ...payload(),
        description: "Placa: ABC1D23\nValor: R$ 10,00\n\nObs: urgente",
      })?.parameters[3],
    ).toBe("Placa: ABC1D23 · Valor: R$ 10,00 · Obs: urgente");
  });

  /**
   * The card a service order creates on its own goes to the order's
   * responsible, who already got the order's WhatsApp: a second message
   * about the same work is noise. No WhatsApp row exists for it.
   */
  it("sends no WhatsApp for the card a service order created", () => {
    expect(
      renderKanbanCardCreatedWhatsApp({ ...payload(), fromServiceOrder: true }),
    ).toBeNull();
  });

  it("words the activity by origin: manual versus from a service order", () => {
    expect(renderKanbanCardCreatedActivity(payload()).description).toContain(
      "criado com sucesso no kanban",
    );

    expect(
      renderKanbanCardCreatedActivity({ ...payload(), fromServiceOrder: true })
        .description,
    ).toContain("criado automaticamente a partir de ordem de serviço");
  });
});

/**
 * The due day in the company's zone (decision 1.1): the WhatsApp line used the
 * process's zone, so a card due on the 23rd in Manaus read the 24th.
 */
describe("kanban card due date", () => {
  it("reads the due instant on the company's day", () => {
    // 03:30 UTC on the 24th = 23:30 on the 23rd in Manaus.
    expect(
      renderKanbanCardCreatedWhatsApp({
        ...payload(),
        dueDate: "2026-09-24T03:30:00.000Z",
        timeZone: "America/Manaus",
      })?.parameters[2],
    ).toBe("23/09/2026");
  });

  it("keeps a date-only due date on the day it names", () => {
    expect(
      renderKanbanCardUpdatedWhatsApp({
        ...payload(),
        dueDate: "2026-09-24T00:00:00.000Z",
        timeZone: "America/Manaus",
      }).parameters[2],
    ).toBe("24/09/2026");
  });
});
