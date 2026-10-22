import database from "@/../infra/database";
import {
  ListTrafficViolationCodeProps,
  ListTrafficViolationCodeByBusinessIdProps,
  TrafficViolationCode,
  SearchTrafficViolationCodeWithCursorProps,
  CursorPaginatedTrafficViolationCode,
} from "../dtos/traffic-violation-code-dto";

import { ITrafficViolationCodeRepository } from "./ITraffic-violation-code-repository";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { escapeLikePattern } from "@/shared/utils/like-pattern";

import { Prisma } from "@prisma/client";

// "745-50" is how a code is printed on the notice and in the picker.
const FULL_CODE = /^(\d{1,6})-(\d{1,4})$/;

/**
 * The picker's search: the code as printed ("745", "745-50") or words of the
 * description, case-insensitive and literal (buildSearchOr escapes % and _).
 */
function trafficViolationCodeSearchWhere(
  search: string | undefined,
): Prisma.TrafficViolationCodeWhereInput {
  const term = search?.trim() ?? "";

  if (!term) return {};

  const contains = { contains: term, mode: "insensitive" as const };
  const fullCode = FULL_CODE.exec(term);

  const conditions: Prisma.TrafficViolationCodeWhereInput[] = [
    { code: contains },
    { description: contains },
    ...(fullCode ? [{ code: fullCode[1], sub_code: Number(fullCode[2]) }] : []),
  ];

  return buildSearchOr(conditions);
}

class TrafficViolationCodeRepository
  implements ITrafficViolationCodeRepository
{
  constructor(private prisma = database) {}

  private getGravityLabel(gravity: string): string {
    const gravityLabels = {
      LIGHT: "Leve",
      MEDIUM: "Média",
      SERIOUS: "Grave",
      VERY_SERIOUS: "Gravíssima",
      NO_POINTS: "Sem Pontuação",
    };

    return gravityLabels[gravity as keyof typeof gravityLabels] || gravity;
  }

  async listTrafficViolationCodes({
    page,
    pageSize,
    search,
    gravity,
    violatorType,
  }: ListTrafficViolationCodeByBusinessIdProps): Promise<ListTrafficViolationCodeProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { code: { contains: normalizedSearch, mode: "insensitive" } },
        { description: { contains: normalizedSearch, mode: "insensitive" } },
        { legal_basis: { contains: normalizedSearch, mode: "insensitive" } },
        { violator_type: { contains: normalizedSearch, mode: "insensitive" } },
        {
          competent_agency: { contains: normalizedSearch, mode: "insensitive" },
        },
      );
    }

    const whereCondition: any = {
      ...(gravity && { gravity }),
      ...(violatorType && {
        violator_type: {
          contains: escapeLikePattern(violatorType),
          mode: "insensitive",
        },
      }),
      ...buildSearchOr(orConditions),
    };

    const [trafficViolationCodeData, total] = await Promise.all([
      this.prisma.trafficViolationCode.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        orderBy: [{ code: "asc" }, { sub_code: "asc" }],
      }),
      this.prisma.trafficViolationCode.count({
        where: whereCondition,
      }),
    ]);

    return {
      data: trafficViolationCodeData,
      total,
    };
  }

  async findTrafficViolationCodeById(
    id: string,
  ): Promise<TrafficViolationCode | null> {
    const code = await this.prisma.trafficViolationCode.findUnique({
      where: { id },
    });

    if (!code) return null;

    return {
      ...code,
      gravityLabel: this.getGravityLabel(code.gravity),
      fullCode: `${code.code}-${code.sub_code}`,
    };
  }

  async searchTrafficViolationCodeWithCursor({
    limit = 10,
    cursor,
    search,
  }: SearchTrafficViolationCodeWithCursorProps): Promise<CursorPaginatedTrafficViolationCode> {
    // The picker used to ignore what was typed: the national table has
    // hundreds of codes, and one not yet scrolled into view "did not exist".
    const items = await this.prisma.trafficViolationCode.findMany({
      where: trafficViolationCodeSearchWhere(search),
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: [{ code: "asc" }, { sub_code: "asc" }, { id: "asc" }],
    });

    const hasMore = items.length > limit;

    const sliced = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (sliced[sliced.length - 1]?.id ?? null) : null;

    const data = sliced.map((code) => ({
      ...code,
      gravityLabel: this.getGravityLabel(code.gravity),
      fullCode: `${code.code}-${code.sub_code}`,
    }));

    return { data, nextCursor, hasMore };
  }
}

export { TrafficViolationCodeRepository, trafficViolationCodeSearchWhere };
