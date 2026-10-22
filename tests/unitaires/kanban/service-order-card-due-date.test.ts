import { describe, expect, it } from "vitest";

import { serviceOrderCardDueDate } from "@/shared/services/kanban-service";

/**
 * The automatic card of a service order is due seven days after the order,
 * counted on the company's calendar (decision 1.2).
 *
 * It used `setDate(getDate() + 7)`, the process's calendar: UTC in the
 * container, São Paulo on a developer machine. A date-only order ("2026-09-17",
 * stored as 00:00 UTC) is the evening of the 16th in Brazil, so the card came
 * due on the 23rd; and nothing tied the due day to the company's zone.
 */
describe("serviceOrderCardDueDate", () => {
  it("counts seven days from a date-only order", () => {
    expect(
      serviceOrderCardDueDate(
        "2026-09-17T00:00:00.000Z",
        "America/Sao_Paulo",
      ).toISOString(),
    ).toBe("2026-09-24T03:00:00.000Z");
  });

  it("counts from the order's day in the company's zone", () => {
    // 01:30 UTC on the 18th is still the 17th in Manaus (UTC-4).
    expect(
      serviceOrderCardDueDate(
        new Date("2026-09-18T01:30:00.000Z"),
        "America/Manaus",
      ).toISOString(),
    ).toBe("2026-09-24T04:00:00.000Z");
  });

  it("starts the due day at the company's midnight, like a card picked on the web", () => {
    // The web's date picker sends the operator's local midnight.
    expect(
      serviceOrderCardDueDate(
        "2026-09-17T03:00:00.000Z",
        "America/Sao_Paulo",
      ).toISOString(),
    ).toBe("2026-09-24T03:00:00.000Z");
  });
});
