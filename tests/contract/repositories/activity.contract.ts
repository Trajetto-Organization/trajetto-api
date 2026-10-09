import { describe, expect, it } from "vitest";

import type { IActivityRepository } from "@/modules/activity/repositories/IActivity-repository";

import { fixedId, type Kind } from "../support";

/**
 * The activity repository's contract (decision 13.2): the timeline feed's
 * keyset cursor, the tenant wall per role and the search — what Atividades
 * and the dashboard feed rely on.
 */

const A = fixedId("0aca", 1);
const B = fixedId("0aca", 2);

const ACTIVITY_FIXTURE = {
  A,
  B,
  adminA: fixedId("0acb", 1),
  adminB: fixedId("0acb", 2),
  master: fixedId("0acb", 3),
} as const;

const F = ACTIVITY_FIXTURE;

/**
 * Ids in creation order (uuid v7 sorts by time; these sort by their suffix).
 * The feed orders by id desc.
 */
const at = (n: number) =>
  `018fde00-0000-7000-8000-${String(n).padStart(12, "0")}`;

interface ActivitySeed {
  id: string;
  businessId: string | null;
  performedBy: string;
  description: string;
  type: string;
}

const ACTIVITY_SEED: ActivitySeed[] = [
  {
    id: at(1),
    businessId: A,
    performedBy: F.adminA,
    description: "Criou o veículo ABC1D23",
    type: "vehicle",
  },
  {
    id: at(2),
    businessId: A,
    performedBy: F.adminA,
    description: "Atualizou o motorista Zeca",
    type: "driver",
  },
  {
    id: at(3),
    businessId: B,
    performedBy: F.adminB,
    description: "Criou o veículo de B",
    type: "vehicle",
  },
  {
    id: at(4),
    businessId: A,
    performedBy: F.master,
    description: "Suporte ajustou o limite",
    type: "business",
  },
  {
    id: at(5),
    businessId: A,
    performedBy: F.adminA,
    description: "Excluiu a filial Centro",
    type: "branch",
  },
];

interface ActivityHarness {
  kind: Kind;
  repo: IActivityRepository;
}

function activityRepositoryContract(harness: () => ActivityHarness): void {
  const feed = (
    extra: Partial<
      Parameters<IActivityRepository["listActivitiesWithCursor"]>[0]
    > = {},
  ) =>
    harness().repo.listActivitiesWithCursor({
      currentUserRole: "BUSINESS_ADMIN",
      userId: F.adminA,
      limit: 2,
      periodDays: 30,
      ...extra,
    });
  const idsOf = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

  it("walks a company's feed newest first, one page at a time, without the platform's rows", async () => {
    const first = await feed();

    expect(idsOf(first.data)).toEqual([at(5), at(2)]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(at(2));

    const second = await feed({ cursor: first.nextCursor! });

    expect(idsOf(second.data)).toEqual([at(1)]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("answers a cursor that is not a row with nothing, never the first page again", async () => {
    const page = await feed({ cursor: at(99) });

    expect(page.data).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it("positions on a cursor outside the reader's scope the way Prisma does", async () => {
    // at(3) is company B's: Prisma reads the row, keeps what sorts after it
    // in the reader's scope (at(2), at(1)) and skip: 1 drops at(2).
    expect(idsOf((await feed({ cursor: at(3), limit: 10 })).data)).toEqual([
      at(1),
    ]);
  });

  it("keeps another company's administrator in their company", async () => {
    const page = await feed({ userId: F.adminB, limit: 10 });

    expect(idsOf(page.data)).toEqual([at(3)]);
  });

  it("shows the MASTER everything, or one company when asked", async () => {
    const all = await feed({
      currentUserRole: "MASTER",
      userId: F.master,
      limit: 10,
    });
    const one = await feed({
      currentUserRole: "MASTER",
      userId: F.master,
      businessId: B,
      limit: 10,
    });

    expect(idsOf(all.data)).toEqual([at(5), at(4), at(3), at(2), at(1)]);
    expect(idsOf(one.data)).toEqual([at(3)]);
  });

  it("searches the description case-insensitively and literally", async () => {
    const found = async (search: string) =>
      idsOf((await feed({ search, limit: 10 })).data);

    expect(await found("VEÍCULO")).toEqual([at(1)]);
    expect(await found("%")).toEqual([]);
  });
}

export { ACTIVITY_FIXTURE, ACTIVITY_SEED, activityRepositoryContract };
export type { ActivityHarness, ActivitySeed };
