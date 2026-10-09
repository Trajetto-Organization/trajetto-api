import { afterCursor } from "@/shared/in-memory/cursor";
import { Prisma } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import { IBranchRepository } from "../IBranch-repository";

import {
  Branch,
  CreateBranchProps,
  ListAllBranchesProps,
  ListBranchProps,
  UpdateBranch,
  SearchBranchWithCursorProps,
  CursorPaginatedBranch,
} from "../../dtos/branch-dto";

import {
  BRANCH_SORT_FALLBACK,
  digitsOf,
  type BranchGroupCount,
  type BranchListFilters,
  type BranchSortKey,
} from "../../usecases/list-branch/branch-list";
import { blankOptionalsToNull } from "../branch-columns";

import {
  compareForOrder,
  type NullsPlacement,
  type OrderValue,
} from "@/shared/pagination/in-memory-order";

type UniqueField = "cnpj" | "corporate_reason" | "email" | "erp_code";

/** The P2002 Postgres raises for the branch table's unique indexes. */
function uniqueViolation(field: UniqueField): Prisma.PrismaClientKnownRequestError {
  const target = field === "cnpj" ? ["cnpj"] : ["businessId", field];

  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${target.map((f) => `\`${f}\``).join(",")})`,
    { code: "P2002", clientVersion: "in-memory", meta: { target } },
  );
}

/** Postgres ILIKE '%term%' after literalContains: a plain case-insensitive substring. */
const containsInsensitive = (value: string | null | undefined, term: string) =>
  (value ?? "").toLowerCase().includes(term.toLowerCase());

const sameText = (a: string | null | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

/** The keys BRANCH_SORT orders with `nulls: "last"`. */
const BRANCH_NULLS: Partial<Record<BranchSortKey, NullsPlacement>> = {
  fantasy_name: "last",
  erp_code: "last",
};

/**
 * The branch table in memory, answering as the repository does (decision
 * 13.2): tenant on every read, the per-company uniques plus the global CNPJ
 * as P2002, case-insensitive lookups, the list's sort with its NULLs-last and
 * (created_at desc, id desc) tiebreaker, and the same breakdown.
 */
class InMemoryBranchRepository implements IBranchRepository {
  public branches: Branch[] = [];

  /** Dependency counts by branch id; the real one counts seven tables. */
  public dependencies = new Map<string, Record<string, number>>();

  private assertUnique(candidate: Branch): void {
    const others = this.branches.filter((branch) => branch.id !== candidate.id);

    if (others.some((branch) => branch.cnpj === candidate.cnpj)) {
      throw uniqueViolation("cnpj");
    }

    const sameCompany = others.filter(
      (branch) => branch.businessId === candidate.businessId,
    );

    // The indexes compare exact values; the use cases check case first.
    for (const field of ["corporate_reason", "email", "erp_code"] as const) {
      const value = candidate[field];

      if (value == null) continue;

      if (sameCompany.some((branch) => branch[field] === value)) {
        throw uniqueViolation(field);
      }
    }
  }

  async createBranch(branchData: CreateBranchProps): Promise<Branch> {
    const branch: Branch = {
      id: uuidV7(),
      ...branchData,
      fantasy_name: branchData.fantasy_name ?? null,
      complement: branchData.complement ?? null,
      erp_code: branchData.erp_code ?? null,
      ...blankOptionalsToNull(branchData),
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.assertUnique(branch);
    this.branches.push(branch);

    return branch;
  }

  private matches(
    branch: Branch,
    filters: BranchListFilters,
    { withFacets }: { withFacets: boolean },
  ): boolean {
    if (branch.businessId !== filters.businessId) return false;

    if (withFacets) {
      if (filters.statuses?.length === 1) {
        const wanted = filters.statuses[0] === "active";

        if ((branch.is_active ?? true) !== wanted) return false;
      }

      if (filters.ufs?.length && !(filters.ufs as string[]).includes(branch.uf)) {
        return false;
      }
    }

    const term = filters.search?.trim() ?? "";

    if (!term) return true;

    const { digits, phoneDigits } = digitsOf(term);

    return (
      [
        branch.id,
        branch.corporate_reason,
        branch.fantasy_name,
        branch.street,
        branch.city,
        branch.uf,
        branch.cnae,
        branch.erp_code,
        branch.responsible_name,
        branch.email,
      ].some((value) => containsInsensitive(value, term)) ||
      (digits !== "" &&
        (branch.cnpj.includes(digits) ||
          branch.cep.includes(digits) ||
          branch.telephone.includes(phoneDigits)))
    );
  }

  /** BRANCH_SORT's order, compared the way Postgres sorts it. */
  private compare(sort: BranchSortKey, order: "asc" | "desc") {
    const valueOf = (branch: Branch): OrderValue => {
      if (sort === "is_active") return branch.is_active ?? true;
      if (sort === "created_at" || sort === "updated_at") return new Date(branch[sort]);

      return branch[sort] ?? null;
    };

    return (a: Branch, b: Branch): number =>
      compareForOrder(valueOf(a), valueOf(b), order, BRANCH_NULLS[sort]) ||
      // Tiebreaker: created_at desc, id desc.
      compareForOrder(new Date(a.created_at), new Date(b.created_at), "desc") ||
      compareForOrder(a.id, b.id, "desc");
  }

  async listAllBranches({
    page,
    pageSize,
    businessId,
    search,
    statuses,
    ufs,
    sort,
    order,
  }: ListAllBranchesProps): Promise<ListBranchProps> {
    const filters: BranchListFilters = { businessId, search, statuses, ufs };

    const resolvedSort = sort ?? BRANCH_SORT_FALLBACK.sort;
    const resolvedOrder = order ?? (sort ? "asc" : BRANCH_SORT_FALLBACK.order);

    const filtered = this.branches
      .filter((branch) => this.matches(branch, filters, { withFacets: true }))
      .sort(this.compare(resolvedSort, resolvedOrder));

    const groups = new Map<string, BranchGroupCount>();

    for (const branch of this.branches) {
      if (!this.matches(branch, filters, { withFacets: false })) continue;

      const isActive = branch.is_active ?? true;
      const key = `${isActive}|${branch.uf}`;
      const group = groups.get(key) ?? {
        is_active: isActive,
        uf: branch.uf,
        count: 0,
        withErpCode: 0,
      };

      group.count += 1;
      if (branch.erp_code != null) group.withErpCode += 1;

      groups.set(key, group);
    }

    const start = (page - 1) * pageSize;

    return {
      data: filtered.slice(start, start + pageSize),
      groups: Array.from(groups.values()),
      withFantasyName: filtered.filter(
        (branch) => branch.fantasy_name != null && branch.fantasy_name !== "",
      ).length,
    };
  }

  /**
   * Mirrors the real precondition, including refusing.
   *
   * A fake that flipped unconditionally would let every test agree with a
   * repository that can refuse, and refusing is the whole point.
   */
  async toggleBranchActive(
    branchId: string,
    expectedActive: boolean,
  ): Promise<Branch | null> {
    const branch = this.branches.find((item) => item.id === branchId);

    if (!branch) return null;
    if ((branch.is_active ?? true) !== expectedActive) return null;

    branch.is_active = !expectedActive;
    branch.updated_at = new Date();

    return branch;
  }

  async updateBranch({ branchData, branchId }: UpdateBranch): Promise<Branch> {
    const branchIndex = this.branches.findIndex(
      (branch) => branch.id === branchId,
    );

    if (branchIndex === -1) {
      // What Prisma's update raises for a missing row.
      throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
        code: "P2025",
        clientVersion: "in-memory",
      });
    }

    const sent = Object.fromEntries(
      Object.entries(branchData).filter(([, value]) => value !== undefined),
    );

    const updated = {
      ...this.branches[branchIndex],
      ...sent,
      ...blankOptionalsToNull(sent),
      updated_at: new Date(),
    } as Branch;

    this.assertUnique(updated);
    this.branches[branchIndex] = updated;

    return updated;
  }

  async findBranchById(branchId: string): Promise<Branch | null> {
    return this.branches.find((branch) => branch.id === branchId) || null;
  }

  async findBranchByErpCode(
    businessId: string,
    erp_code: string,
  ): Promise<Branch | null> {
    return (
      this.branches.find(
        (branch) =>
          branch.businessId === businessId && branch.erp_code === erp_code,
      ) || null
    );
  }

  async findBranchByCnpj(cnpj: string): Promise<Branch | null> {
    return this.branches.find((branch) => branch.cnpj === cnpj) || null;
  }

  async findBranchByEmail(
    businessId: string,
    email: string,
  ): Promise<Branch | null> {
    return (
      this.branches.find(
        (branch) => branch.businessId === businessId && sameText(branch.email, email),
      ) || null
    );
  }

  async findBranchByCorporateReason(
    businessId: string,
    corporate_reason: string,
  ): Promise<Branch | null> {
    return (
      this.branches.find(
        (branch) =>
          branch.businessId === businessId &&
          sameText(branch.corporate_reason, corporate_reason),
      ) || null
    );
  }

  async deleteBranch(branchId: string): Promise<Branch> {
    const branchIndex = this.branches.findIndex(
      (branch) => branch.id === branchId,
    );

    if (branchIndex === -1) {
      throw new Prisma.PrismaClientKnownRequestError("Record to delete does not exist.", {
        code: "P2025",
        clientVersion: "in-memory",
      });
    }

    const [deletedBranch] = this.branches.splice(branchIndex, 1);

    return deletedBranch;
  }

  async searchBranchWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchBranchWithCursorProps): Promise<CursorPaginatedBranch> {
    let filtered = this.branches
      .filter(
        (branch) =>
          branch.businessId === businessId && (branch.is_active ?? true) === true,
      )
      .sort(this.compare("created_at", "desc"));

    if (search) {
      filtered = filtered.filter((branch) =>
        [
          branch.corporate_reason,
          branch.fantasy_name,
          branch.cnpj,
          branch.city,
          branch.uf,
          branch.email,
        ].some((value) => containsInsensitive(value, search)),
      );
    }

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.branches, cursor, this.compare("created_at", "desc"));

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countBranchDependencies(
    branchId: string,
  ): Promise<Record<string, number>> {
    return {
      vehicles: 0,
      drivers: 0,
      serviceOrders: 0,
      accountsPayable: 0,
      fines: 0,
      fuels: 0,
      vehicleChecklists: 0,
      ...this.dependencies.get(branchId),
    };
  }
}

export { InMemoryBranchRepository };
