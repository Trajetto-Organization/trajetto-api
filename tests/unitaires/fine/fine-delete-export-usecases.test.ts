import { describe, expect, it, vi } from "vitest";

import { DeleteFineUseCase } from "@/modules/fine/usecases/delete-fine/delete-fine-usecase";
import { ExportFineUseCase } from "@/modules/fine/usecases/export-fine/export-fine-usecase";
import { ListTrafficViolationCodeUseCase } from "@/modules/fine/usecases/list-traffic-violation-code/list-traffic-violation-code-usecase";
import { SearchTrafficViolationCodeCursorUseCase } from "@/modules/fine/usecases/search-traffic-violation-code-cursor/search-traffic-violation-code-cursor-usecase";

import { InMemoryFineRepository } from "@/modules/fine/repositories/in-memory/in-memory-fine-repository";
import { InMemoryTrafficViolationCodeRepository } from "@/modules/fine/repositories/in-memory/in-memory-traffic-violation-code-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { FineExportRow } from "@/modules/fine/dtos/fine-dto";

/**
 * Deleting and exporting fines, and the national code table, on the twins:
 * another company's fine answers like a missing one and stays, the file
 * holds one company's rows with the screen's filters, its days, times,
 * statuses and name read in the company's zone, and the code picker's
 * cursor continues the way Prisma's does.
 */
const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";
const ADMIN_A = "018f0000-0000-7000-8000-0000000000a1";
const ADMIN_B = "018f0000-0000-7000-8000-0000000000b1";
const MASTER = "018f0000-0000-7000-8000-0000000000f1";
const GHOST = "018f0000-0000-7000-8000-0000000000ff";
const BRANCH = "018f0000-0000-7000-8000-0000000001a1";
const DRIVER = "018f0000-0000-7000-8000-0000000002a1";
const VEHICLE = "018f0000-0000-7000-8000-0000000003a1";
const CODE = "018f0000-0000-7000-8000-0000000004a1";

// 28/09/2026 22:30 in São Paulo: the UTC day is already the 29th.
const NOW = new Date("2026-09-29T01:30:00.000Z");

function makeContext() {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const fines = new InMemoryFineRepository();
  const codes = new InMemoryTrafficViolationCodeRepository();
  const activities = { createActivityIfEnabled: vi.fn() };

  users.user.push(
    { id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    { id: ADMIN_B, role: "BUSINESS_ADMIN", businessId: B } as User,
    { id: MASTER, role: "MASTER", businessId: null } as User,
  );
  businesses.business.push({ id: A } as Business, { id: B } as Business);

  fines.branches.set(BRANCH, { corporate_reason: "Matriz" } as never);
  fines.drivers.set(DRIVER, { name: "João", cpf: "12345678909" });
  fines.vehicles.set(VEHICLE, {
    license_plate: "ABC1D23",
    description: "Caminhão",
  });
  fines.codes.set(CODE, {
    code: "745",
    sub_code: 50,
    description: "Velocidade",
    gravity: "MEDIUM",
    points: 4,
  });

  return {
    fines,
    businesses,
    codes,
    activities,
    remove: new DeleteFineUseCase(
      users,
      fines,
      activities as unknown as NotificationService,
    ),
    exportFines: new ExportFineUseCase(users, businesses, fines),
    listCodes: new ListTrafficViolationCodeUseCase(users, codes),
    searchCodes: new SearchTrafficViolationCodeCursorUseCase(users, codes),
  };
}

function seedFine(
  fines: InMemoryFineRepository,
  businessId: string,
  overrides: {
    due_date?: string;
    payment_date?: string | null;
    observation?: string;
  } = {},
) {
  return fines.createFine({
    violation_date: "2026-09-10T03:00:00.000Z",
    due_date: overrides.due_date ?? "2026-10-10T03:00:00.000Z",
    payment_date: overrides.payment_date ?? null,
    amount: 195.23,
    points: 4,
    observation: overrides.observation,
    businessId,
    branchId: BRANCH,
    driverId: DRIVER,
    vehicleId: VEHICLE,
    trafficViolationCodeId: CODE,
    created_from: "WEB_DASHBOARD",
  } as never);
}

async function collect(iterator: AsyncGenerator<FineExportRow>) {
  const rows: FineExportRow[] = [];
  for await (const row of iterator) rows.push(row);
  return rows;
}

describe("deleting a fine", () => {
  it("deletes the company's own fine and records the activity", async () => {
    const context = makeContext();
    const fine = await seedFine(context.fines, A);

    const deleted = await context.remove.execute(fine.id, ADMIN_A, A);

    expect(deleted.id).toBe(fine.id);
    expect(context.fines.fines).toHaveLength(0);
    expect(context.activities.createActivityIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "delete",
        entityId: fine.id,
        businessId: A,
      }),
    );
  });

  it("answers another company's fine exactly like a missing one, and keeps it", async () => {
    const context = makeContext();
    const fine = await seedFine(context.fines, B);

    const foreign = await context.remove
      .execute(fine.id, ADMIN_A, A)
      .catch((error) => error);
    const missing = await context.remove
      .execute(GHOST, ADMIN_A, A)
      .catch((error) => error);

    expect(foreign).toMatchObject({ statusCode: 404 });
    expect(missing).toMatchObject({ statusCode: 404, code: foreign.code });
    expect(context.fines.fines).toHaveLength(1);
  });

  it("refuses another company's id in the request with TENANT_ACCESS_DENIED", async () => {
    const context = makeContext();
    const fine = await seedFine(context.fines, B);

    await expect(
      context.remove.execute(fine.id, ADMIN_A, B),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_ACCESS_DENIED",
    });
    expect(context.fines.fines).toHaveLength(1);
  });

  it("refuses an unknown user, and turns a repository failure into a pt-BR 500", async () => {
    const context = makeContext();
    const fine = await seedFine(context.fines, A);

    await expect(
      context.remove.execute(fine.id, GHOST, A),
    ).rejects.toMatchObject({ statusCode: 404 });

    vi.spyOn(context.fines, "deleteFine").mockRejectedValueOnce(
      new Error("down"),
    );

    await expect(
      context.remove.execute(fine.id, ADMIN_A, A),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("deletar a multa"),
    });
    expect(context.activities.createActivityIfEnabled).not.toHaveBeenCalled();
  });
});

describe("exporting fines", () => {
  it("exports one company's rows, with status, file name and times in the company's zone", async () => {
    const context = makeContext();
    // Due on the 28th in São Paulo: still today there, so not overdue yet,
    // although the UTC day is already the 29th.
    await seedFine(context.fines, A, { due_date: "2026-09-28T03:00:00.000Z" });
    await seedFine(context.fines, B);

    const result = await context.exportFines.execute({
      userId: ADMIN_A,
      now: NOW,
    });
    const rows = await collect(result.iterator);

    expect(result.filename).toBe("relatorio-multas-2026-09-28");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");

    const status = result.columns.find((column) => column.key === "status");
    const dueDate = result.columns.find((column) => column.key === "due_date");
    const paid = result.columns.find((column) => column.key === "payment_date");
    const createdAt = result.columns.find(
      (column) => column.key === "created_at",
    );

    expect(status?.formatter?.(rows[0].status)).toBe("A vencer");
    expect(dueDate?.formatter?.(rows[0].due_date)).toBe("28/09/2026");
    expect(paid?.formatter?.(null)).toBe("Não paga");
    expect(createdAt?.formatter?.(NOW)).toContain("28/09/2026");
    expect(createdAt?.formatter?.(NOW)).toContain("22:30");
  });

  it("reads the zone from the company, not a São Paulo default", async () => {
    // The case above runs in the default zone, so a hardcoded
    // America/Sao_Paulo would pass it. Rio Branco is two hours behind.
    const context = makeContext();
    const company = context.businesses.business.find((row) => row.id === A)!;

    (company as { timezone?: string }).timezone = "America/Rio_Branco";
    await seedFine(context.fines, A);

    const result = await context.exportFines.execute({
      userId: ADMIN_A,
      now: NOW,
    });
    const createdAt = result.columns.find(
      (column) => column.key === "created_at",
    );

    expect(result.filename).toBe("relatorio-multas-2026-09-28");
    expect(createdAt?.formatter?.(NOW)).toContain("20:30");
  });

  it("applies the screen's filters and refuses an empty result with NO_FINES_TO_EXPORT", async () => {
    const context = makeContext();
    await seedFine(context.fines, A, {
      payment_date: "2026-09-20T03:00:00.000Z",
    });
    await seedFine(context.fines, A, { observation: "Recorrer" });

    const paid = await context.exportFines.execute({
      userId: ADMIN_A,
      statuses: ["PAID"],
      now: NOW,
    });

    expect((await collect(paid.iterator)).map((row) => row.status)).toEqual([
      "PAID",
    ]);

    const searched = await context.exportFines.execute({
      userId: ADMIN_A,
      search: "recorrer",
      now: NOW,
    });

    expect(
      (await collect(searched.iterator)).map((row) => row.observation),
    ).toEqual(["Recorrer"]);

    await expect(
      context.exportFines.execute({
        userId: ADMIN_A,
        statuses: ["OVERDUE"],
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "NO_FINES_TO_EXPORT" });
  });

  it("makes the MASTER name the company, and refuses another company to a company user", async () => {
    const context = makeContext();
    await seedFine(context.fines, B);

    await expect(
      context.exportFines.execute({ userId: MASTER, now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });
    await expect(
      context.exportFines.execute({ userId: ADMIN_A, businessId: B, now: NOW }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });

    const master = await context.exportFines.execute({
      userId: MASTER,
      businessId: B,
      now: NOW,
    });

    expect(await collect(master.iterator)).toHaveLength(1);
  });

  it("refuses an unknown user with 404", async () => {
    const context = makeContext();

    await expect(
      context.exportFines.execute({ userId: GHOST, now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("the traffic violation code table", () => {
  function seedCodes(codes: InMemoryTrafficViolationCodeRepository) {
    const base = {
      legal_basis: "CTB",
      violator_type: "Condutor",
      gravity_raw: "Leve",
      points: 3,
      competent_agency: "Estadual",
    };

    return [
      codes.add({
        ...base,
        code: "501",
        sub_code: 0,
        description: "Dirigir sem habilitação",
        gravity: "VERY_SERIOUS",
      }),
      codes.add({
        ...base,
        code: "605",
        sub_code: 1,
        description: "Avançar o sinal vermelho",
        gravity: "VERY_SERIOUS",
      }),
      codes.add({
        ...base,
        code: "745",
        sub_code: 50,
        description: "Velocidade superior à máxima",
        gravity: "MEDIUM",
      }),
      codes.add({
        ...base,
        code: "746",
        sub_code: 30,
        description: "Velocidade muito superior",
        gravity: "SERIOUS",
      }),
    ];
  }

  it("pages and filters the national table by gravity and search", async () => {
    const context = makeContext();
    seedCodes(context.codes);

    const page = await context.listCodes.execute(ADMIN_A, 1, 2);

    expect(page.total).toBe(4);
    expect(page.data.map((code) => code.code)).toEqual(["501", "605"]);

    const serious = await context.listCodes.execute(
      ADMIN_A,
      1,
      10,
      undefined,
      "VERY_SERIOUS",
    );

    expect(serious.data.map((code) => code.code)).toEqual(["501", "605"]);

    const searched = await context.listCodes.execute(
      ADMIN_A,
      1,
      10,
      "velocidade",
    );

    expect(searched.data.map((code) => code.code)).toEqual(["745", "746"]);
  });

  it("refuses an unknown user, and turns a repository failure into a pt-BR 500", async () => {
    const context = makeContext();

    await expect(context.listCodes.execute(GHOST, 1, 10)).rejects.toMatchObject(
      { statusCode: 404 },
    );

    vi.spyOn(context.codes, "listTrafficViolationCodes").mockRejectedValueOnce(
      new Error("down"),
    );

    await expect(
      context.listCodes.execute(ADMIN_A, 1, 10),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("códigos de infrações"),
    });
  });

  it("continues after the cursor row even when the new search no longer matches it, like Prisma", async () => {
    const context = makeContext();
    const [, signal] = seedCodes(context.codes);

    // The picker typed "velocidade" after a page that ended on "605-1": Prisma
    // reads the cursor row from the table and keeps the matches after it, then
    // skip: 1 drops the first of them. The twin answered an empty page.
    const next = await context.searchCodes.execute({
      userId: ADMIN_A,
      limit: 10,
      search: "velocidade",
      cursor: signal.id,
    });

    expect(next.data.map((code) => code.fullCode)).toEqual(["746-30"]);

    const unknown = await context.searchCodes.execute({
      userId: ADMIN_A,
      limit: 10,
      cursor: GHOST,
    });

    expect(unknown.data).toEqual([]);
  });
});
