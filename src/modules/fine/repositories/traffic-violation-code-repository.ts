import database from "@/../infra/database";
import {
  ListTrafficViolationCodeProps,
  ListTrafficViolationCodeByBusinessIdProps,
  TrafficViolationCode,
  SearchTrafficViolationCodeWithCursorProps,
  CursorPaginatedTrafficViolationCode,
} from "../dtos/traffic-violation-code-dto";

import { ITrafficViolationCodeRepository } from "./ITraffic-violation-code-repository";

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
        violator_type: { contains: violatorType, mode: "insensitive" },
      }),
      ...(orConditions.length > 0 && { OR: orConditions }),
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
  }: SearchTrafficViolationCodeWithCursorProps): Promise<CursorPaginatedTrafficViolationCode> {
    const items = await this.prisma.trafficViolationCode.findMany({
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: [{ code: "asc" }, { sub_code: "asc" }],
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

export { TrafficViolationCodeRepository };
