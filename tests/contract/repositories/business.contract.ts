import { describe, expect, it } from "vitest";

import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import type { CreateBusinessProps } from "@/modules/business/dtos/business-dto";

import { expectPrismaCode, fixedId, minute, type Kind } from "../support";

/**
 * The business repository's contract: what the companies screen (MASTER),
 * the company picker and the delete guard rely on.
 */

const MARK = "Contratoemp";

const A = fixedId("0b0a", 1);
const B = fixedId("0b0a", 2);
const C = fixedId("0b0a", 3);
const D = fixedId("0b0a", 4);
// Same created_at as D, bigger id: `id desc` must put it first.
const E = fixedId("0b0a", 5);
const MISSING = fixedId("0b0a", 99);

type SeedBusiness = CreateBusinessProps & {
  id: string;
  is_active: boolean;
  created_at: Date;
};

const base = (n: number) => ({
  cep: `0100100${n}`,
  street: "Rua das Flores",
  address_number: String(n),
  cnae: "4930202",
  telephone: `1199999000${n}`,
});

const BUSINESSES: SeedBusiness[] = [
  {
    ...base(1),
    id: A,
    corporate_reason: `${MARK} Alfa Transportes LTDA`,
    fantasy_name: "Alfa",
    city: "São Paulo",
    uf: "SP",
    cnpj: "11222333000181",
    erp_code: "ERP-1",
    responsible_name: "Ana Souza",
    email: `alfa@${MARK}.com.br`,
    is_active: true,
    created_at: minute(1),
  },
  {
    ...base(2),
    id: B,
    corporate_reason: `${MARK} Bravo Logística`,
    fantasy_name: null,
    city: "Curitiba",
    uf: "PR",
    cnpj: "22333444000192",
    erp_code: null,
    responsible_name: "Bruno Lima",
    email: `bravo@${MARK}.com.br`,
    is_active: false,
    created_at: minute(2),
  },
  {
    ...base(3),
    id: C,
    corporate_reason: `${MARK} Charlie Cargas`,
    fantasy_name: "Charlie 50%",
    city: "São Paulo",
    uf: "SP",
    cnpj: "45723174000110",
    erp_code: "erp-3",
    responsible_name: "Célia Prado",
    email: `charlie@${MARK}.com.br`,
    is_active: true,
    created_at: minute(3),
  },
  {
    ...base(4),
    id: D,
    corporate_reason: `${MARK} Delta Fretes`,
    fantasy_name: "Delta",
    city: "Campinas",
    uf: "SP",
    cnpj: "33444666000103",
    erp_code: null,
    responsible_name: "Davi Rocha",
    email: `delta@${MARK}.com.br`,
    is_active: true,
    created_at: minute(4),
  },
  {
    ...base(5),
    id: E,
    corporate_reason: `${MARK} Echo Express`,
    fantasy_name: null,
    city: "Curitiba",
    uf: "PR",
    cnpj: "44555666000104",
    erp_code: "ERP-5",
    responsible_name: "Eva Nunes",
    email: `echo@${MARK}.com.br`,
    is_active: true,
    created_at: minute(4),
  },
];

interface BusinessHarness {
  kind: Kind;
  repo: IBusinessRepository;
  /** Adds a branch, a user and a driver pointing at `businessId`. */
  addDependents(businessId: string): Promise<void>;
}

const idsOf = (rows: { id?: string | null }[]) => rows.map((row) => row.id);

function businessRepositoryContract(harness: () => BusinessHarness): void {
  const masterList = (
    extra: Partial<Parameters<IBusinessRepository["listBusiness"]>[0]> = {},
  ) =>
    harness().repo.listBusiness({
      page: 1,
      pageSize: 50,
      businessId: A,
      currentUserRole: "MASTER",
      search: MARK,
      ...extra,
    });

  describe("listBusiness", () => {
    it("shows a company user only their own company, whatever the search", async () => {
      const own = await masterList({
        businessId: B,
        currentUserRole: "BUSINESS_ADMIN",
      });

      expect(idsOf(own.data)).toEqual([B]);
      expect(own.groups).toEqual([
        { is_active: false, uf: "PR", count: 1, withErpCode: 0 },
      ]);

      const foreign = await masterList({
        businessId: B,
        currentUserRole: "BUSINESS_USER",
        search: "Alfa",
      });

      expect(foreign.data).toEqual([]);
    });

    it("orders newest first with the id breaking a created_at tie, and pages", async () => {
      const first = await masterList({ pageSize: 3 });
      const second = await masterList({ page: 2, pageSize: 3 });

      expect(idsOf(first.data)).toEqual([E, D, C]);
      expect(idsOf(second.data)).toEqual([B, A]);
    });

    it("sorts a nullable column with the empty ones last in both directions", async () => {
      const asc = await masterList({ sort: "erp_code", order: "asc" });
      const desc = await masterList({ sort: "erp_code", order: "desc" });

      // Byte order: upper case before lower case ("ERP-1" < "ERP-5" < "erp-3");
      // the two NULLs keep the created_at desc / id desc tiebreaker.
      expect(idsOf(asc.data)).toEqual([A, E, C, D, B]);
      expect(idsOf(desc.data)).toEqual([C, E, A, D, B]);
    });

    it("searches case-insensitively, literally, by id and by the digits of a formatted CNPJ", async () => {
      const list = (search: string) =>
        masterList({ search }).then((result) => idsOf(result.data).sort());

      expect(await list("célia")).toEqual([C]);
      expect(await list("50%")).toEqual([C]);
      expect(await list("45.723.174/0001-10")).toEqual([C]);
      expect(await list(D.slice(-6))).toEqual([D]);
    });

    it("counts the breakdown over the search, not over the page or the facets", async () => {
      const result = await masterList({
        pageSize: 1,
        statuses: ["active"],
        ufs: ["SP"],
      });

      expect(idsOf(result.data)).toEqual([D]);

      const groups = [...result.groups].sort(
        (x, y) =>
          x.uf.localeCompare(y.uf) || Number(x.is_active) - Number(y.is_active),
      );

      expect(groups).toEqual([
        { is_active: false, uf: "PR", count: 1, withErpCode: 0 },
        { is_active: true, uf: "PR", count: 1, withErpCode: 1 },
        { is_active: true, uf: "SP", count: 3, withErpCode: 2 },
      ]);
      expect(result.topCities).toEqual([
        { value: "São Paulo/SP", count: 2 },
        { value: "Campinas/SP", count: 1 },
      ]);
    });
  });

  describe("searchBusinessWithCursor", () => {
    it("offers only active companies, newest first, and walks the cursor", async () => {
      const { repo } = harness();

      const first = await repo.searchBusinessWithCursor({
        limit: 2,
        businessId: A,
        currentUserRole: "MASTER",
        search: MARK.toUpperCase(),
      });

      expect(idsOf(first.data)).toEqual([E, D]);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBe(D);

      const second = await repo.searchBusinessWithCursor({
        limit: 2,
        cursor: first.nextCursor!,
        businessId: A,
        currentUserRole: "MASTER",
        search: MARK,
      });

      expect(idsOf(second.data)).toEqual([C, A]);
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeNull();
    });

    it("keeps a company user inside their company", async () => {
      const result = await harness().repo.searchBusinessWithCursor({
        limit: 10,
        businessId: C,
        currentUserRole: "BUSINESS_ADMIN",
        search: MARK,
      });

      expect(idsOf(result.data)).toEqual([C]);
    });

    it("answers a cursor the list cannot continue from with nothing, never from the top", async () => {
      const { repo } = harness();
      const page = (cursor: string) =>
        repo.searchBusinessWithCursor({
          limit: 10,
          cursor,
          businessId: A,
          currentUserRole: "MASTER",
          search: MARK,
        });

      // No such row.
      expect((await page(MISSING)).data).toEqual([]);
      // B is inactive (outside the `where`): Prisma still positions on it and
      // skip: 1 drops the first row after it, A.
      expect((await page(B)).data).toEqual([]);
    });
  });

  describe("lookups", () => {
    it("finds names, ERP codes and e-mails whatever their case, CNPJ exactly", async () => {
      const { repo } = harness();

      expect(
        (
          await repo.findBusinessByCorporateReason(
            `${MARK} ALFA transportes ltda`,
          )
        )?.id,
      ).toBe(A);
      expect((await repo.findBusinessByErpcode("Erp-3"))?.id).toBe(C);
      expect((await repo.findBusinessByEmail(`DELTA@${MARK}.com.br`))?.id).toBe(
        D,
      );
      expect((await repo.findBusinessByCnpj("45723174000110"))?.id).toBe(C);
      // ILIKE with the pattern escaped: "_" is not a wildcard.
      expect(await repo.findBusinessByErpcode("ERP_1")).toBeNull();
      expect(await repo.findBusinessById(MISSING)).toBeNull();
    });

    it("reads the AI quota projection", async () => {
      const { repo } = harness();

      expect(await repo.findAIUsage(B)).toEqual({
        id: B,
        corporate_reason: `${MARK} Bravo Logística`,
        fantasy_name: null,
        ai_analysis_limit: expect.any(Number),
      });
      expect(await repo.findAIUsage(MISSING)).toBeNull();
    });
  });

  describe("writes", () => {
    const fresh = (
      tag: string,
      overrides: Partial<CreateBusinessProps>,
    ): CreateBusinessProps => ({
      ...base(9),
      corporate_reason: `${MARK} Nova ${tag}`,
      city: "Recife",
      uf: "PE",
      cnpj: `9900000000${tag.length}`.padEnd(14, "7"),
      responsible_name: "Nova Pessoa",
      email: `nova-${tag}@${MARK}.com.br`,
      ...overrides,
    });

    it("refuses a duplicate CNPJ, e-mail, corporate reason or ERP code (P2002)", async () => {
      const { repo } = harness();

      await expectPrismaCode(
        repo.createBusiness(fresh("a", { cnpj: "11222333000181" })),
        "P2002",
      );
      await expectPrismaCode(
        repo.createBusiness(fresh("bb", { email: `alfa@${MARK}.com.br` })),
        "P2002",
      );
      await expectPrismaCode(
        repo.createBusiness(
          fresh("ccc", { corporate_reason: `${MARK} Bravo Logística` }),
        ),
        "P2002",
      );
      await expectPrismaCode(
        repo.createBusiness(fresh("dddd", { erp_code: "ERP-1" })),
        "P2002",
      );
      await expectPrismaCode(
        repo.updateBusiness({
          businessId: D,
          businessData: { email: `echo@${MARK}.com.br` },
        }),
        "P2002",
      );

      expect((await repo.findBusinessById(D))?.email).toBe(
        `delta@${MARK}.com.br`,
      );
    });

    it("stores an empty ERP code and complement as NULL, so many companies can have none", async () => {
      const { repo } = harness();

      const created = await repo.createBusiness(
        fresh("semerp", {
          cnpj: "55666777000105",
          erp_code: "",
          complement: "",
        }),
      );

      expect(created.erp_code).toBeNull();
      expect(created.complement).toBeNull();
      expect(created.is_active).toBe(true);
      expect(created.timezone).toBe("America/Sao_Paulo");

      // A second company without an ERP code is not a duplicate.
      const another = await repo.createBusiness(
        fresh("semerp2", { cnpj: "55666777000106", erp_code: null }),
      );

      await repo.deleteBusiness(another.id!);
      await repo.deleteBusiness(created.id!);
    });

    it("writes null to clear a column and leaves undefined alone", async () => {
      const { repo } = harness();

      const updated = await repo.updateBusiness({
        businessId: A,
        businessData: { fantasy_name: null, city: undefined },
      });

      expect(updated.fantasy_name).toBeNull();
      expect(updated.city).toBe("São Paulo");

      await repo.updateBusiness({
        businessId: A,
        businessData: { fantasy_name: "Alfa" },
      });
    });

    it("refuses to update, delete or re-limit a company that does not exist (P2025) and deletes nothing", async () => {
      const { repo } = harness();

      await expectPrismaCode(
        repo.updateBusiness({
          businessId: MISSING,
          businessData: { city: "X" },
        }),
        "P2025",
      );
      await expectPrismaCode(repo.updateVehicleLimit(MISSING, 3), "P2025");
      await expectPrismaCode(repo.updateAILimit(MISSING, 3), "P2025");
      await expectPrismaCode(repo.deleteBusiness(MISSING), "P2025");

      // `splice(-1, 1)` used to delete the newest company here.
      for (const { id } of BUSINESSES) {
        expect(await repo.findBusinessById(id)).not.toBeNull();
      }
    });

    it("flips the active flag only from the state the caller saw", async () => {
      const { repo } = harness();

      expect(await repo.toggleBusinessActive(D, false)).toBeNull();

      const off = await repo.toggleBusinessActive(D, true);
      expect(off?.is_active).toBe(false);

      const on = await repo.toggleBusinessActive(D, false);
      expect(on?.is_active).toBe(true);

      expect(await repo.toggleBusinessActive(MISSING, true)).toBeNull();
    });

    it("counts what points at a company, per company", async () => {
      const { repo, addDependents } = harness();

      await addDependents(E);

      expect(await repo.countBusinessDependencies(E)).toEqual({
        branches: 1,
        users: 1,
        drivers: 1,
      });
      expect(await repo.countBusinessDependencies(D)).toEqual({
        branches: 0,
        users: 0,
        drivers: 0,
      });
    });
  });
}

export { BUSINESSES, businessRepositoryContract };
export type { BusinessHarness, SeedBusiness };
