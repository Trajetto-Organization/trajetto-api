import { describe, expect, it } from "vitest";

import {
  assignmentPreviewSchema,
  listUnroutedDeliveriesSchema,
  openStopsQuerySchema,
} from "@/schemas/route-schema";

/**
 * fastify-type-provider-zod replaces request.query with the parsed value, and
 * the route controllers parse it again with the same schema. A transform that
 * cannot read its own output back turns every such request into a 400 — the
 * "Adicionar entregas" sheet (includeUnscheduled=true by default) listed
 * nothing because of it.
 */
const twice = <T>(schema: { parse: (value: unknown) => T }, raw: unknown): T =>
  schema.parse(schema.parse(raw));

describe("route querystrings survive the controller's second parse", () => {
  it("keeps includeUnscheduled true and false through both parses", () => {
    const base = { scheduledFrom: "2026-10-06", scheduledTo: "2026-10-07" };

    expect(
      twice(listUnroutedDeliveriesSchema, {
        ...base,
        includeUnscheduled: "true",
      }),
    ).toMatchObject({ includeUnscheduled: true });
    expect(
      twice(listUnroutedDeliveriesSchema, {
        ...base,
        includeUnscheduled: "false",
      }),
    ).toMatchObject({ includeUnscheduled: false });
    expect(
      twice(listUnroutedDeliveriesSchema, {}).includeUnscheduled,
    ).toBeUndefined();
  });

  it("still refuses anything but true or false on the wire", () => {
    expect(
      listUnroutedDeliveriesSchema.safeParse({ includeUnscheduled: "yes" })
        .success,
    ).toBe(false);
  });

  it("keeps the dates, lists and pagination of the picker stable", () => {
    const once = listUnroutedDeliveriesSchema.parse({
      page: "2",
      pageSize: "20",
      ufs: "SP,MG",
      kinds: "DELIVERY",
      scheduledFrom: "2026-10-06",
      scheduledTo: "2026-10-07",
      includeUnscheduled: "true",
    });

    expect(listUnroutedDeliveriesSchema.parse(once)).toEqual(once);
  });

  it("keeps the assignment preview and open-stops queries stable", () => {
    const delivery = "018f7e70-0000-7000-8000-0000000000aa";
    const preview = {
      driverId: "018f7e70-0000-7000-8000-0000000000d1",
      scheduled_date: "2026-10-06",
      deliveryIds: delivery,
    };

    expect(twice(assignmentPreviewSchema, preview)).toEqual(
      assignmentPreviewSchema.parse(preview),
    );
    expect(twice(openStopsQuerySchema, { deliveryIds: delivery })).toEqual({
      deliveryIds: [delivery],
    });
  });
});
