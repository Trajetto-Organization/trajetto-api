import { describe, expect, it } from "vitest";

import { updateKanbanCardSchema } from "@/schemas/update-kanban-card-schema";

/**
 * PATCH /kanban/card/update/:cardId and the card's `completed`.
 *
 * With zod 3 an edit that left `completed` out unchecked the card: the
 * preprocess ran on the missing key and stringToBoolean(undefined) is false.
 * zod 4 leaves a missing key out of an optional result, so the card keeps
 * what is stored (docs/deploy.md, zod 4). The web sends the field on every
 * save, as a hidden input, so the form behaves as before.
 */
describe("updateKanbanCardSchema.completed", () => {
  it("is left out when the edit leaves it out: the stored value stays", () => {
    const parsed = updateKanbanCardSchema.parse({ title: "Trocar pneus" });

    expect(parsed).not.toHaveProperty("completed");
  });

  it("reads the form's text and a JSON boolean alike", () => {
    expect(updateKanbanCardSchema.parse({ completed: "true" }).completed).toBe(
      true,
    );
    expect(updateKanbanCardSchema.parse({ completed: "false" }).completed).toBe(
      false,
    );
    expect(updateKanbanCardSchema.parse({ completed: true }).completed).toBe(
      true,
    );
  });
});
