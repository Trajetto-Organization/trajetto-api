import { describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  IntegrationRepository,
  eventIdFloor,
} from "@/modules/integration/repositories/integration-repository";

/**
 * How /integration/v1/events finds a tenant's events.
 *
 * delivery_event carries its own businessId (copied from the delivery on
 * write) and an index on (businessId, id) for exactly this walk. The query
 * used to filter through the relation instead — `delivery: { businessId }` —
 * which Postgres answers either by walking the primary key across every
 * tenant's events, or by joining every delivery the tenant ever had and
 * sorting the result. Both grow with the whole table, not with the page.
 */
function repositoryWith(findMany = vi.fn().mockResolvedValue([])) {
  const fake = { deliveryEvent: { findMany } };

  return {
    findMany,
    repository: new IntegrationRepository(fake as never),
  };
}

describe("the public events feed", () => {
  it("filters on the event's own tenant column, not through the delivery", async () => {
    const { findMany, repository } = repositoryWith();

    await repository.listEvents({ businessId: "b1", limit: 50 } as never);

    const args = findMany.mock.calls[0][0];

    expect(args.where).toEqual({ businessId: "b1" });
    expect(args.where).not.toHaveProperty("delivery");

    // The cursor stays the id: uuid v7, so time-ordered, and unchanged for an
    // integrator already mid-walk.
    expect(args.orderBy).toEqual({ id: "asc" });
  });

  it("keeps updated_since on created_at, and starts the id walk at the window", async () => {
    const { findMany, repository } = repositoryWith();

    await repository.listEvents({
      businessId: "b1",
      limit: 50,
      updated_since: "2026-09-01T00:00:00.000Z",
    } as never);

    const since = new Date("2026-09-01T00:00:00.000Z");

    expect(findMany.mock.calls[0][0].where).toEqual({
      businessId: "b1",
      created_at: { gte: since },
      id: { gte: eventIdFloor(since) },
    });
  });
});

describe("the id floor of an updated_since window", () => {
  it("sorts below every uuid v7 minted from ten minutes before the instant", () => {
    const since = new Date("2026-09-01T12:00:00.000Z");
    const floor = eventIdFloor(since)!;

    const mintedAt = (ms: number) => {
      const hex = ms.toString(16).padStart(12, "0");

      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
    };

    // At the instant, and with the API clock up to ten minutes behind.
    expect(mintedAt(since.getTime()) >= floor).toBe(true);
    expect(mintedAt(since.getTime() - 9 * 60 * 1000) >= floor).toBe(true);

    // Well before the window: excluded from the walk, as created_at would.
    expect(mintedAt(since.getTime() - 60 * 60 * 1000) >= floor).toBe(false);
  });

  it("is only as safe as the ids being uuid v7", () => {
    // The floor reads the millisecond timestamp at the head of a uuid v7. A
    // different id default would make updated_since silently skip events.
    const schema = readFileSync(
      resolve(process.cwd(), "prisma/schema.prisma"),
      "utf8",
    );

    const model = schema.slice(schema.indexOf("model DeliveryEvent {"));

    expect(model).toMatch(/^\s*id\s+String\s+@id\s+@default\(uuid\(7\)\)/m);
  });
});

/**
 * The public name of each event in the feed.
 *
 * "A caminho" (decision 6.4) and every occurrence report (TWR-6) now write a
 * delivery event, and both fell to `delivery.note`: an integrator saw a
 * "note" with no text where an occurrence had been reported. A request still
 * waiting for the tower, denied, or closed without a decision (decision 6.3)
 * took no effect and sent no webhook, so the feed does not announce it either.
 */
describe("the public topic of a feed event", () => {
  const event = (fields: Record<string, unknown>) => ({
    id: "018f0000-0000-7000-8000-000000000001",
    created_at: new Date("2026-09-17T12:00:00.000Z"),
    occurred_at: null,
    status_from: null,
    status_to: null,
    received_by: null,
    note: null,
    occurrence: null,
    delivery: { id: "d1", code: "E-1", invoice_key: null },
    ...fields,
  });

  async function topicsOf(rows: Array<Record<string, unknown>>, limit = 50) {
    const { repository } = repositoryWith(vi.fn().mockResolvedValue(rows));

    return repository.listEvents({ businessId: "b1", limit } as never);
  }

  it("names 'a caminho' like the arrival, not as a note", async () => {
    const { data } = await topicsOf([event({ type: "ON_THE_WAY" })]);

    expect(data.map((row) => row.topic)).toEqual(["delivery.on_the_way"]);
  });

  it.each([["NOT_REQUIRED"], ["APPROVED"]])(
    "names an occurrence that took effect (%s) as the webhook does",
    async (status) => {
      const { data } = await topicsOf([
        event({ type: "OCCURRENCE", occurrence: { authorization_status: status } }),
      ]);

      expect(data.map((row) => row.topic)).toEqual(["occurrence.reported"]);
    },
  );

  it.each([["PENDING"], ["DENIED"], ["SUPERSEDED"]])(
    "leaves out a request that took no effect (%s)",
    async (status) => {
      const { data } = await topicsOf([
        event({ type: "OCCURRENCE", occurrence: { authorization_status: status } }),
      ]);

      expect(data).toEqual([]);
    },
  );

  // Decision 14.3: a delivery request is a delivery, not a problem; its fact
  // is the PROOF. Approved, it must not ALSO read as occurrence.reported.
  it.each([["NOT_REQUIRED"], ["APPROVED"], ["PENDING"], ["SUPERSEDED"]])(
    "leaves out a DELIVERED occurrence (%s): the PROOF is its public fact",
    async (status) => {
      const { data } = await topicsOf([
        event({
          type: "OCCURRENCE",
          occurrence: { authorization_status: status, category: "DELIVERED" },
        }),
        event({ type: "PROOF" }),
      ]);

      expect(data.map((row) => row.topic)).toEqual(["proof.registered"]);
    },
  );

  // Decision 14.7: a route plan change is planning, not a public fact, and
  // must not fall into delivery.note.
  it.each([["ROUTE_ADDED"], ["ROUTE_REMOVED"]])("leaves out %s", async (type) => {
    const { data } = await topicsOf([event({ type, note: "Rota 12" }), event({ type: "PROOF" })]);

    expect(data.map((row) => row.topic)).toEqual(["proof.registered"]);
  });

  it("reads the occurrence's category with the event", async () => {
    const { findMany, repository } = repositoryWith();

    await repository.listEvents({ businessId: "b1", limit: 50 } as never);

    expect(findMany.mock.calls[0][0].select.occurrence).toEqual({
      select: { authorization_status: true, category: true },
    });
  });

  it("keeps the other names as they were", async () => {
    const { data } = await topicsOf([
      event({ type: "ARRIVAL" }),
      event({ type: "PROOF" }),
      event({ type: "STATUS_CHANGE", status_from: "IN_TRANSIT", status_to: "FAILED" }),
      event({ type: "NOTE", note: "Ligar antes." }),
    ]);

    expect(data.map((row) => row.topic)).toEqual([
      "delivery.arrived",
      "proof.registered",
      "delivery.failed",
      "delivery.note",
    ]);
  });

  it("keeps walking past a left-out event: the cursor is the page's last row", async () => {
    const rows = [
      event({ id: "018f0000-0000-7000-8000-000000000001", type: "ARRIVAL" }),
      event({
        id: "018f0000-0000-7000-8000-000000000002",
        type: "OCCURRENCE",
        occurrence: { authorization_status: "PENDING" },
      }),
      event({ id: "018f0000-0000-7000-8000-000000000003", type: "PROOF" }),
    ];

    const page = await topicsOf(rows, 2);

    expect(page.data.map((row) => row.id)).toEqual([
      "018f0000-0000-7000-8000-000000000001",
    ]);
    expect(page.next_cursor).toBe("018f0000-0000-7000-8000-000000000002");
  });
});
