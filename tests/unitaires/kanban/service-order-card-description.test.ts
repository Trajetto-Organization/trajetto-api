import { describe, expect, it } from "vitest";

import { serviceOrderCardDescription } from "@/shared/services/kanban-service";

/**
 * The text of a service order's automatic card carries no amount (wave 3,
 * owner's decision: a driver sees the orders he works on WITHOUT costs).
 *
 * The card goes to the order's responsible, often a driver, who reads it
 * whole through GET /kanban/card/:cardId (the app opens it from the
 * notification) and in the WhatsApp of a card handed over to him. It said
 * "Valor: R$ 12.500,00" on its second line.
 */
describe("serviceOrderCardDescription", () => {
  it("names the plate, the responsible and the kind, and no amount", () => {
    const description = serviceOrderCardDescription({
      vehicleLicensePlate: "ABC1D23",
      responsibleUserId: "018f0000-0000-7000-8000-0000000000a1",
      maintenanceType: "EXTERNAL",
    });

    expect(description).toBe(
      "Veículo: ABC1D23\nResponsável: Atribuído\nTipo: Externo",
    );
    expect(description).not.toMatch(/Valor|R\$/);
  });

  it("keeps the fallbacks of an order without a plate or a responsible", () => {
    expect(
      serviceOrderCardDescription({
        vehicleLicensePlate: "",
        responsibleUserId: undefined,
        maintenanceType: "INTERNAL",
      }),
    ).toBe("Veículo: N/A\nResponsável: Não atribuído\nTipo: Interno");
  });
});
