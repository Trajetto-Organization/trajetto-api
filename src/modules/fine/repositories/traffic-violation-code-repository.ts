import database from "@/../infra/database";
import {
  TrafficViolationCode,
  ListTrafficViolationCodeProps,
  ListTrafficViolationCodeByBusinessIdProps,
  TrafficViolationCodeStatistics,
} from "../dtos/traffic-violation-code-dto";

import { ITrafficViolationCodeRepository } from "./ITraffic-violation-code-repository";
import { formatDate } from "@/config/format-values";

class TrafficViolationCodeRepository
  implements ITrafficViolationCodeRepository
{
  constructor(private prisma = database) {}

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

    const trafficViolationCodeData =
      await this.prisma.trafficViolationCode.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        orderBy: [{ code: "asc" }, { sub_code: "asc" }],
      });

    const total = await this.prisma.trafficViolationCode.count({
      where: whereCondition,
    });

    const transformedData = trafficViolationCodeData.map((code) => ({
      id: code.id ?? "N/A",
      code: code.code ?? "N/A",
      sub_code: code.sub_code ?? 0,
      description: code.description ?? "N/A",
      legal_basis: code.legal_basis ?? "N/A",
      violator_type: code.violator_type ?? "N/A",
      gravity: code.gravity ?? "NO_POINTS",
      gravity_raw: code.gravity_raw ?? "N/A",
      points: code.points ?? 0,
      competent_agency: code.competent_agency ?? "N/A",
      gravityLabel: this.getGravityLabel(code.gravity),
      fullCode: `${code.code}-${code.sub_code}`,
      created_at: formatDate(code.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(code.updated_at, "pt-BR") ?? "N/A",
    }));

    return {
      data: transformedData,
      total,
    };
  }

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

  async findTrafficViolationCodeByCode(
    code: string,
    subCode: number = 0,
  ): Promise<TrafficViolationCode | null> {
    const violationCode = await this.prisma.trafficViolationCode.findFirst({
      where: {
        code,
        sub_code: subCode,
      },
    });

    if (!violationCode) return null;

    return {
      ...violationCode,
      gravityLabel: this.getGravityLabel(violationCode.gravity),
      fullCode: `${violationCode.code}-${violationCode.sub_code}`,
    };
  }

  async getTrafficViolationCodeStatistics(): Promise<TrafficViolationCodeStatistics> {
    const [
      total,
      light,
      medium,
      serious,
      verySerious,
      noPoints,
      violatorTypeData,
    ] = await Promise.all([
      this.prisma.trafficViolationCode.count(),
      this.prisma.trafficViolationCode.count({ where: { gravity: "LIGHT" } }),
      this.prisma.trafficViolationCode.count({ where: { gravity: "MEDIUM" } }),
      this.prisma.trafficViolationCode.count({ where: { gravity: "SERIOUS" } }),
      this.prisma.trafficViolationCode.count({
        where: { gravity: "VERY_SERIOUS" },
      }),
      this.prisma.trafficViolationCode.count({
        where: { gravity: "NO_POINTS" },
      }),
      this.prisma.trafficViolationCode.groupBy({
        by: ["violator_type"],
        _count: true,
      }),
    ]);

    const byViolatorType: Record<string, number> = {};
    violatorTypeData.forEach((item) => {
      byViolatorType[item.violator_type] = item._count;
    });

    return {
      total,
      light,
      medium,
      serious,
      verySerious,
      noPoints,
      byViolatorType,
    };
  }

  async getMostUsedViolationCodes(
    businessId: string,
    limit: number = 10,
  ): Promise<TrafficViolationCode[]> {
    const mostUsedCodes = await this.prisma.trafficViolationCode.findMany({
      where: {
        fines: {
          some: {
            businessId,
          },
        },
      },
      include: {
        _count: {
          select: {
            fines: {
              where: {
                businessId,
              },
            },
          },
        },
      },
      orderBy: {
        fines: {
          _count: "desc",
        },
      },
      take: limit,
    });

    return mostUsedCodes.map((code) => ({
      ...code,
      gravityLabel: this.getGravityLabel(code.gravity),
      fullCode: `${code.code}-${code.sub_code}`,
    }));
  }

  async searchTrafficViolationCodes(
    search: string,
    limit: number = 20,
  ): Promise<TrafficViolationCode[]> {
    const normalizedSearch = search.trim().toLowerCase();

    const codes = await this.prisma.trafficViolationCode.findMany({
      where: {
        OR: [
          { code: { contains: normalizedSearch, mode: "insensitive" } },
          { description: { contains: normalizedSearch, mode: "insensitive" } },
        ],
      },
      orderBy: [{ code: "asc" }, { sub_code: "asc" }],
      take: limit,
    });

    return codes.map((code) => ({
      ...code,
      gravityLabel: this.getGravityLabel(code.gravity),
      fullCode: `${code.code}-${code.sub_code}`,
    }));
  }
}

export { TrafficViolationCodeRepository };
