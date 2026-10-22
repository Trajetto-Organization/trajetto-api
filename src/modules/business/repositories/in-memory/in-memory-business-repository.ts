import { v7 as uuidV7 } from "uuid";
import { IBusinessRepository } from "../IBusiness-repository";

import {
  compareForOrder,
  type NullsPlacement,
  type OrderValue,
} from "@/shared/pagination/in-memory-order";

import {
  BUSINESS_SORT_FALLBACK,
  TOP_PLACES,
  cityLabel,
  digitsOf,
  type BusinessGroupCount,
  type BusinessListFilters,
  type BusinessSortKey,
} from "../../usecases/list-business/business-list";

import {
  BUSINESS_COLUMN_DEFAULTS,
  withColumnDefaults,
} from "@/shared/in-memory/column-defaults";
import {
  assertUniqueValue,
  requireIndex,
} from "@/shared/in-memory/prisma-errors";
import { afterCursor } from "@/shared/in-memory/cursor";

import {
  CreateBusinessProps,
  Business,
  ListBusinessProps,
  UpdateBusiness,
  ListBusinessByBusinessIdProps,
  SearchBusinessWithCursorProps,
  CursorPaginatedBusiness,
} from "../../dtos/business-dto";

/** Postgres ILIKE '%term%' after literalContains: a plain case-insensitive substring. */
const containsInsensitive = (value: string | null | undefined, term: string) =>
  (value ?? "").toLowerCase().includes(term.toLowerCase());

/** The keys BUSINESS_SORT orders with `nulls: "last"`. */
const BUSINESS_NULLS: Partial<Record<BusinessSortKey, NullsPlacement>> = {
  fantasy_name: "last",
  erp_code: "last",
};

const createdAtOf = (business: Business) => new Date(business.created_at ?? 0);

/** The columns Business declares @unique (case-sensitive, NULLs allowed). */
const UNIQUE_COLUMNS = [
  "corporate_reason",
  "cnpj",
  "erp_code",
  "email",
] as const;

class InMemoryBusinessRepository implements IBusinessRepository {
  public business: Business[] = [];

  /**
   * The rows that point at a company, for countBusinessDependencies. The twin
   * has no branch/user/driver tables; a test seeds them here so a delete
   * guard is exercised against real counts instead of a constant zero.
   */
  public dependents: {
    branches: { businessId: string }[];
    users: { businessId: string | null }[];
    drivers: { businessId: string }[];
  } = { branches: [], users: [], drivers: [] };

  private assertUnique(candidate: Business): void {
    for (const column of UNIQUE_COLUMNS) {
      assertUniqueValue(this.business, candidate, column);
    }
  }

  async createBusiness(businessData: CreateBusinessProps): Promise<Business> {
    const newBusiness: Business = {
      id: uuidV7(),
      ...withColumnDefaults(BUSINESS_COLUMN_DEFAULTS, businessData),
      is_active: true,
      erp_code: businessData.erp_code || null,
      complement: businessData.complement || null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.assertUnique(newBusiness);

    this.business.push(newBusiness);
    return newBusiness;
  }

  /** businessListWhere, row by row. */
  private matches(
    business: Business,
    filters: BusinessListFilters,
    { withFacets }: { withFacets: boolean },
  ): boolean {
    if (
      filters.ownBusinessId !== undefined &&
      business.id !== filters.ownBusinessId
    ) {
      return false;
    }

    if (withFacets) {
      if (filters.statuses?.length === 1) {
        const wanted = filters.statuses[0] === "active";

        if ((business.is_active ?? true) !== wanted) return false;
      }

      if (
        filters.ufs?.length &&
        !(filters.ufs as string[]).includes(business.uf)
      ) {
        return false;
      }
    }

    const term = filters.search?.trim() ?? "";

    if (!term) return true;

    const { digits, phoneDigits } = digitsOf(term);

    return (
      [
        business.id,
        business.corporate_reason,
        business.fantasy_name,
        business.city,
        business.uf,
        business.street,
        business.address_number,
        business.complement,
        business.cnae,
        business.erp_code,
        business.responsible_name,
        business.email,
      ].some((value) => containsInsensitive(value, term)) ||
      (digits !== "" &&
        (business.cep.includes(digits) ||
          business.telephone.includes(phoneDigits) ||
          business.cnpj.includes(digits)))
    );
  }

  /** BUSINESS_SORT, compared the way Postgres sorts it. */
  private compare(sort: BusinessSortKey, order: "asc" | "desc") {
    const valueOf = (business: Business): OrderValue => {
      if (sort === "is_active") return business.is_active ?? true;
      if (sort === "created_at" || sort === "updated_at") {
        return new Date(business[sort] ?? 0);
      }

      return business[sort] ?? null;
    };

    return (a: Business, b: Business): number =>
      compareForOrder(valueOf(a), valueOf(b), order, BUSINESS_NULLS[sort]) ||
      compareForOrder(createdAtOf(a), createdAtOf(b), "desc") ||
      compareForOrder(a.id, b.id, "desc");
  }

  async listBusiness({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
    statuses,
    ufs,
    sort,
    order,
  }: ListBusinessByBusinessIdProps): Promise<ListBusinessProps> {
    const filters: BusinessListFilters = {
      search,
      statuses,
      ufs,
      ...(currentUserRole !== "MASTER" && { ownBusinessId: businessId }),
    };

    const resolvedSort = sort ?? BUSINESS_SORT_FALLBACK.sort;
    const resolvedOrder =
      order ?? (sort ? "asc" : BUSINESS_SORT_FALLBACK.order);

    const filtered = this.business
      .filter((business) =>
        this.matches(business, filters, { withFacets: true }),
      )
      .sort(this.compare(resolvedSort, resolvedOrder));

    const groups = new Map<string, BusinessGroupCount>();

    for (const business of this.business) {
      if (!this.matches(business, filters, { withFacets: false })) continue;

      const isActive = business.is_active ?? true;
      const key = `${isActive}|${business.uf}`;
      const group = groups.get(key) ?? {
        is_active: isActive,
        uf: business.uf,
        count: 0,
        withErpCode: 0,
      };

      group.count += 1;
      if (business.erp_code != null) group.withErpCode += 1;

      groups.set(key, group);
    }

    // GROUP BY city, uf ORDER BY count desc, city, uf LIMIT 3.
    const places = new Map<
      string,
      { city: string; uf: string; count: number }
    >();

    for (const business of filtered) {
      const key = `${business.city}|${business.uf}`;
      const place = places.get(key) ?? {
        city: business.city,
        uf: business.uf,
        count: 0,
      };

      place.count += 1;
      places.set(key, place);
    }

    const topCities = Array.from(places.values())
      .sort(
        (a, b) =>
          b.count - a.count ||
          compareForOrder(a.city, b.city, "asc") ||
          compareForOrder(a.uf, b.uf, "asc"),
      )
      .slice(0, TOP_PLACES)
      .map((place) => ({
        value: cityLabel(place.city, place.uf),
        count: place.count,
      }));

    const start = (page - 1) * pageSize;

    return {
      // The twin has no vehicle table: no registered fleet.
      data: filtered.slice(start, start + pageSize).map((business) => ({
        ...business,
        vehicle_count: business.vehicle_count ?? 0,
      })),
      groups: Array.from(groups.values()),
      topCities,
    };
  }

  /**
   * Mirrors the real precondition, including refusing.
   *
   * A fake that flipped the flag unconditionally would let every test agree
   * with a repository that can answer null, and null is the whole point.
   */
  async toggleBusinessActive(
    businessId: string,
    expectedActive: boolean,
  ): Promise<Business | null> {
    const business = this.business.find((item) => item.id === businessId);

    if (!business) return null;
    if (business.is_active !== expectedActive) return null;

    business.is_active = !expectedActive;

    return business;
  }

  async updateBusiness({
    businessData,
    businessId,
  }: UpdateBusiness): Promise<Business> {
    const index = requireIndex(this.business, (b) => b.id === businessId);

    // As the repository sends it: only undefined is "not sent"; a null
    // clears the column (it used to be dropped here, and a cleared ERP code
    // stayed in the twin while the database erased it).
    const filteredData = Object.fromEntries(
      Object.entries(businessData).filter(([, value]) => value !== undefined),
    );

    const updatedBusiness: Business = {
      ...this.business[index],
      ...filteredData,
      updated_at: new Date(),
    } as Business;

    this.assertUnique(updatedBusiness);

    this.business[index] = updatedBusiness;
    return updatedBusiness;
  }

  async deleteBusiness(businessId: string): Promise<Business> {
    const index = requireIndex(
      this.business,
      (b) => b.id === businessId,
      "delete",
    );

    const deletedBusiness = this.business.splice(index, 1)[0];
    return deletedBusiness;
  }

  async findBusinessById(businessId: string): Promise<Business | null> {
    const found = this.business.find((b) => b.id === businessId);

    if (!found) {
      return null;
    }

    return found;
  }

  async findBusinessByCnpj(cnpj: string): Promise<Business | null> {
    const found = this.business.find((b) => b.cnpj === cnpj);

    if (!found) {
      return null;
    }

    return found;
  }

  async findBusinessByCorporateReason(
    corporateReason: string,
  ): Promise<Business | null> {
    const found = this.business.find(
      (b) =>
        b.corporate_reason &&
        b.corporate_reason.toLowerCase() === corporateReason.toLowerCase(),
    );

    if (!found) {
      return null;
    }

    return found;
  }

  async findBusinessByErpcode(erpCode: string): Promise<Business | null> {
    const found = this.business.find(
      (b) => b.erp_code && b.erp_code.toLowerCase() === erpCode.toLowerCase(),
    );

    if (!found) {
      return null;
    }

    return found;
  }

  async findBusinessByEmail(email: string): Promise<Business | null> {
    const found = this.business.find(
      (b) => b.email && b.email.toLowerCase() === email.toLowerCase(),
    );

    if (!found) {
      return null;
    }

    return found;
  }

  async updateVehicleLimit(
    businessId: string,
    vehicle_limit: number,
  ): Promise<Business> {
    const index = requireIndex(this.business, (b) => b.id === businessId);

    this.business[index] = {
      ...this.business[index],
      vehicle_limit,
    };

    return this.business[index];
  }

  async updateAILimit(
    businessId: string,
    ai_analysis_limit: number,
  ): Promise<Business> {
    const index = requireIndex(this.business, (b) => b.id === businessId);

    this.business[index] = {
      ...this.business[index],
      ai_analysis_limit,
    };

    return this.business[index];
  }

  async searchBusinessWithCursor({
    limit = 10,
    cursor,
    businessId,
    currentUserRole,
    search,
  }: SearchBusinessWithCursorProps): Promise<CursorPaginatedBusiness> {
    // Newest first with the id as tiebreaker, like the repository.
    const createdAt = (business: Business) =>
      new Date(
        (business as { created_at?: Date | string }).created_at ?? 0,
      ).getTime();

    const newestFirst = (a: Business, b: Business) =>
      createdAt(b) - createdAt(a) || compareForOrder(a.id, b.id, "desc");

    let filtered = this.business
      .filter(
        (business) =>
          business.is_active &&
          (currentUserRole === "MASTER" || business.id === businessId),
      )
      .sort(newestFirst);

    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter((business) =>
        [
          business.corporate_reason,
          business.fantasy_name ?? "",
          business.cnpj,
          business.email,
          business.responsible_name,
        ].some((value) => value.toLowerCase().includes(term)),
      );
    }

    filtered = afterCursor(filtered, this.business, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async findAIUsage(businessId: string) {
    const found = this.business.find((b) => b.id === businessId);

    if (!found) {
      return null;
    }

    return {
      id: found.id || "",
      corporate_reason: found.corporate_reason,
      fantasy_name: found.fantasy_name || null,
      ai_analysis_limit: found.ai_analysis_limit ?? 0,
    };
  }
  async countBusinessDependencies(
    businessId: string,
  ): Promise<{ branches: number; users: number; drivers: number }> {
    const of = (rows: { businessId: string | null }[]) =>
      rows.filter((row) => row.businessId === businessId).length;

    return {
      branches: of(this.dependents.branches),
      users: of(this.dependents.users),
      drivers: of(this.dependents.drivers),
    };
  }
}

export { InMemoryBusinessRepository };
