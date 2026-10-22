import { v7 as uuidV7 } from "uuid";

import {
  CursorPaginatedTrafficViolationCode,
  ListTrafficViolationCodeByBusinessIdProps,
  ListTrafficViolationCodeProps,
  SearchTrafficViolationCodeWithCursorProps,
  TrafficViolationCode,
} from "../../dtos/traffic-violation-code-dto";

import { ITrafficViolationCodeRepository } from "../ITraffic-violation-code-repository";

import { afterCursor } from "@/shared/in-memory/cursor";

const GRAVITY_LABELS: Record<TrafficViolationCode["gravity"], string> = {
  LIGHT: "Leve",
  MEDIUM: "Média",
  SERIOUS: "Grave",
  VERY_SERIOUS: "Gravíssima",
  NO_POINTS: "Sem Pontuação",
};

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** code asc, sub_code asc, id asc: the repository's order. */
function byCodeOrder(a: TrafficViolationCode, b: TrafficViolationCode): number {
  return (
    compareText(a.code, b.code) ||
    a.sub_code - b.sub_code ||
    compareText(a.id, b.id)
  );
}

// Same shape as the repository's search: "745-50" as printed.
const FULL_CODE = /^(\d{1,6})-(\d{1,4})$/;

/**
 * The national table of infraction codes in memory, with the repository's
 * semantics: ordered by code, sub-code and id; the search is the code as
 * printed or a literal case-insensitive substring of code or description;
 * the cursor continues after the given row.
 */
class InMemoryTrafficViolationCodeRepository
  implements ITrafficViolationCodeRepository
{
  public codes: TrafficViolationCode[] = [];

  add(
    data: Omit<TrafficViolationCode, "id" | "created_at" | "updated_at"> & {
      id?: string;
    },
  ): TrafficViolationCode {
    const now = new Date();
    const code: TrafficViolationCode = {
      ...data,
      id: data.id ?? uuidV7(),
      created_at: now,
      updated_at: now,
    };

    this.codes.push(code);

    return code;
  }

  async findTrafficViolationCodeById(
    id: string,
  ): Promise<TrafficViolationCode | null> {
    const code = this.codes.find((row) => row.id === id);

    return code ? this.decorate(code) : null;
  }

  async listTrafficViolationCodes({
    page,
    pageSize,
    search,
    gravity,
    violatorType,
  }: ListTrafficViolationCodeByBusinessIdProps): Promise<ListTrafficViolationCodeProps> {
    const violator = violatorType?.toLowerCase();

    const rows = this.sorted().filter(
      (code) =>
        (!gravity || code.gravity === gravity) &&
        (!violator || code.violator_type.toLowerCase().includes(violator)) &&
        this.matchesListSearch(code, search),
    );
    const skip = (page - 1) * pageSize;

    return { data: rows.slice(skip, skip + pageSize), total: rows.length };
  }

  async searchTrafficViolationCodeWithCursor({
    limit = 10,
    cursor,
    search,
  }: SearchTrafficViolationCodeWithCursorProps): Promise<CursorPaginatedTrafficViolationCode> {
    // Prisma's cursor: positioned on the cursor ROW of the whole table, so a
    // cursor outside the current search still continues after its place.
    const rows = afterCursor(
      this.sorted().filter((code) => this.matches(code, search)),
      this.codes,
      cursor,
      byCodeOrder,
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((code) => this.decorate(code));

    return {
      data: page,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  /** The paged list searches more columns than the picker (see the repository). */
  private matchesListSearch(
    code: TrafficViolationCode,
    search: string | undefined,
  ): boolean {
    const needle = search?.trim().toLowerCase() ?? "";

    if (!needle) return true;

    return [
      code.id,
      code.code,
      code.description,
      code.legal_basis,
      code.violator_type,
      code.competent_agency,
    ].some((value) => value.toLowerCase().includes(needle));
  }

  private matches(
    code: TrafficViolationCode,
    search: string | undefined,
  ): boolean {
    const term = search?.trim() ?? "";

    if (!term) return true;

    const needle = term.toLowerCase();
    const fullCode = FULL_CODE.exec(term);

    return (
      code.code.toLowerCase().includes(needle) ||
      code.description.toLowerCase().includes(needle) ||
      Boolean(
        fullCode &&
          code.code === fullCode[1] &&
          code.sub_code === Number(fullCode[2]),
      )
    );
  }

  private sorted(): TrafficViolationCode[] {
    return [...this.codes].sort(byCodeOrder);
  }

  private decorate(code: TrafficViolationCode): TrafficViolationCode {
    return {
      ...code,
      gravityLabel: GRAVITY_LABELS[code.gravity] ?? code.gravity,
      fullCode: `${code.code}-${code.sub_code}`,
    };
  }
}

export { InMemoryTrafficViolationCodeRepository };
