import { describe, expect, it } from "vitest";

import { InMemoryFineRepository } from "@/modules/fine/repositories/in-memory/in-memory-fine-repository";

/**
 * The in-memory fines table keeps FineRepository's semantics (decision
 * 13.2): the same cases tests/E2E/fine-http.test.ts proves over Postgres —
 * tenant, order with its tiebreaker, facets, search over the joins, labels
 * only for the company's own branches, `null` clearing a column, and the
 * tenant in every write.
 */

const A = "business-a";
const B = "business-b";

const TODAY_START = new Date("2026-09-28T03:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function seeded() {
  const repo = new InMemoryFineRepository();

  repo.branches.set("centro", {
    businessId: A,
    corporate_reason: "Filial Centro",
  });
  repo.branches.set("norte", {
    businessId: A,
    corporate_reason: "Filial Norte",
  });
  repo.branches.set("secreta", {
    businessId: B,
    corporate_reason: "Filial Secreta",
  });
  repo.drivers.set("zeca", { name: "Zeca Alves", cpf: "111" });
  repo.drivers.set("ana", { name: "Ana Borges", cpf: "222" });
  repo.vehicles.set("v1", {
    license_plate: "FNE1A01",
    description: "Caminhão 1",
  });
  repo.codes.set("speed", {
    code: "7455",
    sub_code: 0,
    description: "Velocidade",
    gravity: "MEDIUM",
    points: 4,
  });

  for (let index = 0; index < 6; index += 1) {
    const fine = await repo.createFine({
      businessId: A,
      branchId: index % 2 === 0 ? "centro" : "norte",
      driverId: index % 2 === 0 ? "zeca" : "ana",
      vehicleId: "v1",
      trafficViolationCodeId: "speed",
      violation_date: new Date(TODAY_START.getTime() - 40 * DAY),
      due_date: new Date(
        TODAY_START.getTime() + (index % 3 === 1 ? -10 : 20) * DAY,
      ),
      payment_date:
        index % 3 === 0 ? new Date(TODAY_START.getTime() - 20 * DAY) : null,
      amount: 100 + index * 10,
      points: 4,
      created_from: "WEB_DASHBOARD",
    });

    // Distinct creation instants, newest last.
    fine.created_at = new Date(TODAY_START.getTime() + index * 60_000);
    repo.fines[repo.fines.length - 1].created_at = fine.created_at;
  }

  await repo.createFine({
    businessId: B,
    branchId: "secreta",
    driverId: "zeca",
    vehicleId: "v1",
    trafficViolationCodeId: "speed",
    violation_date: new Date(TODAY_START.getTime() - 5 * DAY),
    due_date: new Date(TODAY_START.getTime() + 5 * DAY),
    amount: 999,
    points: 4,
    created_from: "WEB_DASHBOARD",
  });

  return repo;
}

const list = (
  repo: InMemoryFineRepository,
  extra: Record<string, unknown> = {},
) =>
  repo.listFines({
    page: 1,
    pageSize: 10,
    businessId: A,
    todayStart: TODAY_START,
    ...extra,
  });

describe("InMemoryFineRepository.listFines", () => {
  it("lists one company, newest first, with the status of each row", async () => {
    const { data } = await list(await seeded());

    expect(data.map((fine) => Number(fine.amount))).toEqual([
      150, 140, 130, 120, 110, 100,
    ]);
    expect(data.map((fine) => fine.status)).toEqual([
      "PENDING",
      "OVERDUE",
      "PAID",
      "PENDING",
      "OVERDUE",
      "PAID",
    ]);
  });

  it("orders by a join with the newest first inside a tie", async () => {
    const { data } = await list(await seeded(), {
      sort: "driverName",
      order: "asc",
    });

    expect(data.map((fine) => Number(fine.amount))).toEqual([
      150, 130, 110, 140, 120, 100,
    ]);
  });

  it("filters by status and searches the joins", async () => {
    const repo = await seeded();

    expect((await list(repo, { statuses: ["OVERDUE"] })).data).toHaveLength(2);
    expect((await list(repo, { search: "zeca" })).data).toHaveLength(3);
    expect((await list(repo, { search: "7455-0" })).data).toHaveLength(6);
    expect((await list(repo, { search: "130,00" })).data).toHaveLength(1);
  });

  it("groups by status without the facets, and names only its own branches", async () => {
    const { groups, labels } = await list(await seeded(), {
      branchIds: ["secreta"],
    });

    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(6);
    expect(labels.branchId).toEqual({
      centro: "Filial Centro",
      norte: "Filial Norte",
    });
  });
});

describe("InMemoryFineRepository writes", () => {
  it("returns the row with every column Prisma returns, nulls included", async () => {
    const repo = await seeded();

    const keyed = await repo.createFine({
      businessId: A,
      branchId: "centro",
      driverId: "zeca",
      vehicleId: "v1",
      trafficViolationCodeId: "speed",
      violation_date: TODAY_START,
      due_date: new Date(TODAY_START.getTime() + DAY),
      amount: 10,
      points: 0,
      created_from: "WEB_DASHBOARD",
      client_submission_id: "018f0000-0000-7000-8000-00000000c0de",
    });

    expect(keyed.client_submission_id).toBe(
      "018f0000-0000-7000-8000-00000000c0de",
    );
    expect(repo.fines[0].client_submission_id).toBeNull();
  });

  it("clears a column sent as null, like Prisma", async () => {
    const repo = await seeded();
    const paid = repo.fines.find((fine) => fine.payment_date)!;

    const updated = await repo.updateFine({
      fineId: paid.id,
      businessId: A,
      fineData: { payment_date: null },
    });

    expect(updated.payment_date).toBeNull();
  });

  it("does not touch another company's fine", async () => {
    const repo = await seeded();
    const foreign = repo.fines.find((fine) => fine.businessId === B)!;

    await expect(
      repo.updateFine({
        fineId: foreign.id,
        businessId: A,
        fineData: { amount: 1 },
      }),
    ).rejects.toThrow();
    await expect(repo.deleteFine(foreign.id, A)).rejects.toThrow();
    expect(repo.fines.find((fine) => fine.id === foreign.id)).toBeDefined();
  });
});
