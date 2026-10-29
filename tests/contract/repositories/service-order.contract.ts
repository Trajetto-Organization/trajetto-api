import { expect, it } from "vitest";

import type { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import type { CreateServiceOrderProps } from "@/modules/service-order/dtos/service-order-dto";

import { expectPrismaCode, fixedId, type Kind } from "../support";

/**
 * The service order repository's contract (decision 13.2): what a create
 * stores (origin and original GPS), the submission key, the guarded delete's
 * tenant wall, and the list's order and search.
 */

const A = fixedId("05ea", 1);
const B = fixedId("05ea", 2);

const SERVICE_ORDER_FIXTURE = {
  A,
  B,
  branchA: fixedId("05eb", 1),
  branchB: fixedId("05eb", 2),
  userA: fixedId("05ec", 1),
  userB: fixedId("05ec", 2),
  vehicleA: fixedId("05ed", 1),
  vehicleB: fixedId("05ed", 2),
  plateA: "SOA1B23",
  plateB: "SOB1B23",
} as const;

const F = SERVICE_ORDER_FIXTURE;

const order = (
  extra: Partial<CreateServiceOrderProps>,
): CreateServiceOrderProps => ({
  date: new Date("2026-09-10T12:00:00.000Z"),
  maintenance_type: "INTERNAL",
  total_amount: 150,
  description: "Troca de óleo",
  current_mileage_at_service: 10000,
  maintenance_interval_km_at_service: 10000,
  businessId: A,
  vehicleId: F.vehicleA,
  responsibleUserId: F.userA,
  branchId: F.branchA,
  created_from: "WEB_DASHBOARD",
  ...extra,
});

/** Created in order; minute = created_at. */
const SERVICE_ORDER_SEED: Array<{
  key: string;
  minute: number;
  data: CreateServiceOrderProps;
}> = [
  {
    key: "app",
    minute: 1,
    data: order({
      description: "Pneu furado na estrada",
      created_from: "MOBILE_APP",
      location_source: "GPS_MANUAL",
      latitude: -23.5,
      longitude: -46.6,
      latitude_original: -23.55,
      longitude_original: 0,
      client_submission_id: "so-sub-1",
    }),
  },
  { key: "web", minute: 2, data: order({ description: "Revisão dos freios" }) },
  {
    key: "b",
    minute: 0,
    data: order({
      businessId: B,
      vehicleId: F.vehicleB,
      responsibleUserId: F.userB,
      branchId: F.branchB,
      description: "Revisão de B",
      client_submission_id: "so-sub-1",
    }),
  },
];

interface ServiceOrderHarness {
  kind: Kind;
  repo: IServiceOrderRepository;
  id(key: string): string;
}

function serviceOrderRepositoryContract(
  harness: () => ServiceOrderHarness,
): void {
  const list = (extra: Record<string, unknown> = {}) =>
    harness().repo.listServiceOrders({
      page: 1,
      pageSize: 50,
      businessId: A,
      ...extra,
    } as never);

  it("stores where the order came from and the GPS before the manual edit", async () => {
    const h = harness();
    const stored = await h.repo.findServiceOrderById(h.id("app"));

    expect(stored).toMatchObject({
      created_from: "MOBILE_APP",
      location_source: "GPS_MANUAL",
      latitude_original: -23.55,
      longitude_original: 0,
    });
    expect(await h.repo.findServiceOrderById(h.id("web"))).toMatchObject({
      created_from: "WEB_DASHBOARD",
      location_source: null,
      latitude_original: null,
    });
  });

  it("refuses a replayed submission key in the company (P2002) and finds it only there", async () => {
    const h = harness();

    await expectPrismaCode(
      h.repo.createServiceOrder(order({ client_submission_id: "so-sub-1" })),
      "P2002",
    );

    expect(
      (await h.repo.findServiceOrderBySubmissionId(A, "so-sub-1"))?.id,
    ).toBe(h.id("app"));
    expect(
      (await h.repo.findServiceOrderBySubmissionId(B, "so-sub-1"))?.id,
    ).toBe(h.id("b"));
  });

  it("lists one company newest first and searches the description and the plate", async () => {
    const h = harness();

    expect((await list()).data.map((row) => row.id)).toEqual([
      h.id("web"),
      h.id("app"),
    ]);
    expect((await list({ search: "PNEU" })).data.map((row) => row.id)).toEqual([
      h.id("app"),
    ]);
    expect((await list({ search: F.plateA.toLowerCase() })).data).toHaveLength(
      2,
    );
    expect((await list({ search: "Revisão de B" })).data).toEqual([]);
  });

  it("answers another company's order as missing in the guarded delete, deleting nothing", async () => {
    const h = harness();

    expect(await h.repo.deleteServiceOrderGuarded(h.id("b"), A)).toEqual({
      missing: true,
    });
    expect(
      await h.repo.deleteServiceOrderGuarded(fixedId("05ee", 99), A),
    ).toEqual({ missing: true });
    expect(await h.repo.findServiceOrderById(h.id("b"))).not.toBeNull();
  });
}

export {
  SERVICE_ORDER_FIXTURE,
  SERVICE_ORDER_SEED,
  serviceOrderRepositoryContract,
};
export type { ServiceOrderHarness };
