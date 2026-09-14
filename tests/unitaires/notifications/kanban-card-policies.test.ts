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

  it("translates the priority into the labelled emoji", () => {
    expect(renderKanbanCardCreatedWhatsApp(payload())).toContain("🔴 *Alta*");

    expect(
      renderKanbanCardCreatedWhatsApp({ ...payload(), priority: "urgent" }),
    ).toContain("🆘 *Urgente*");
  });

  /**
   * Creation and update say different things — being handed a brand-new card
   * is not the same as inheriting one mid-flight, and the driver reading the
   * message should know which happened.
   */
  it("keeps the created and updated headers distinct", () => {
    expect(renderKanbanCardCreatedWhatsApp(payload())).toContain(
      "Novo Card Atribuído",
    );

    expect(renderKanbanCardUpdatedWhatsApp(payload())).toContain(
      "Card Atualizado",
    );

    expect(renderKanbanCardUpdatedInApp(payload(), ctx, {
      id: "user-9",
      role: "BUSINESS_ADMIN",
      driverId: null,
    }).title).toBe("Card Atualizado e Atribuído");
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
