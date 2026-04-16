import { IDriverRepository } from "./IDriver-repository";
import {
  Driver,
  CreateDriverProps,
  ListDriverByBusinessIdProps,
  ListDriverProps,
  UpdateDriver,
  SearchDriverWithCursorProps,
  CursorPaginatedDriver,
} from "../dtos/driver-dto";

import database from "@/../infra/database";

class DriverRepository implements IDriverRepository {
  constructor(private prisma = database) {}

  async createDriver(driverData: CreateDriverProps): Promise<Driver> {
    const driverCreated = await this.prisma.driver.create({
      data: driverData,
    });

    return driverCreated;
  }

  async listDrivers({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListDriverByBusinessIdProps): Promise<ListDriverProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      const digitSearch = normalizedSearch.replace(/\D/g, "");

      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { name: { contains: normalizedSearch, mode: "insensitive" } },
        { cnh: { contains: normalizedSearch, mode: "insensitive" } },
        { city: { contains: normalizedSearch, mode: "insensitive" } },
        { uf: { contains: normalizedSearch, mode: "insensitive" } },
        { street: { contains: normalizedSearch, mode: "insensitive" } },
        { address_number: { contains: normalizedSearch, mode: "insensitive" } },
        // Business ID and name (MASTER only)
        ...(currentUserRole === "MASTER"
          ? [
              {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              },
              {
                business: {
                  corporate_reason: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              },
            ]
          : []),
        { branchId: { contains: normalizedSearch, mode: "insensitive" } },
        ...(digitSearch
          ? [
              { cpf: { contains: digitSearch, mode: "insensitive" } },
              { cep: { contains: digitSearch, mode: "insensitive" } },
              { rg: { contains: digitSearch, mode: "insensitive" } },
            ]
          : []),
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const [driverData, total] = await Promise.all([
      this.prisma.driver.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        include: {
          branch: {
            select: {
              corporate_reason: true,
            },
          },
          business: {
            select: {
              corporate_reason: true,
            },
          },
        },
        orderBy: {
          created_at: "desc",
        },
      }),
      this.prisma.driver.count({
        where: whereCondition,
      }),
    ]);

    return {
      data: driverData,
      total,
    };
  }

  async updateDriver({ driverData, driverId }: UpdateDriver): Promise<Driver> {
    const filteredData = Object.fromEntries(
      Object.entries(driverData).filter(([_, value]) => value !== undefined),
    );

    const updateDriver = await this.prisma.driver.update({
      where: {
        id: driverId,
      },
      data: filteredData,
    });

    return updateDriver;
  }

  async deleteDriver(driverId: string): Promise<Driver> {
    const deleteDriver = await this.prisma.driver.delete({
      where: {
        id: driverId,
      },
    });

    return deleteDriver;
  }

  async findDriverById(driverId: string): Promise<Driver | null> {
    const findDriverById = await this.prisma.driver.findUnique({
      where: {
        id: driverId,
      },
      include: {
        branch: {
          select: {
            is_active: true,
          },
        },
        User: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    return findDriverById;
  }

  async findDriverByCpf(cpf: string): Promise<Driver | null> {
    const findDriverByCpf = await this.prisma.driver.findUnique({
      where: {
        cpf: cpf,
      },
    });

    return findDriverByCpf;
  }

  async findDriverByRg(rg: string): Promise<Driver | null> {
    const findDriverByRg = await this.prisma.driver.findUnique({
      where: {
        rg: rg,
      },
    });

    return findDriverByRg;
  }

  async findDriverByDriverLicense(cnh: string): Promise<Driver | null> {
    const findDriverByDriverLicense = await this.prisma.driver.findFirst({
      where: {
        cnh: {
          equals: cnh,
          mode: "insensitive",
        },
      },
    });

    return findDriverByDriverLicense;
  }

  async findDriverWithUser(driverId: string): Promise<
    | (Driver & {
        user?: { id: string; email: string; name: string } | null;
      })
    | null
  > {
    const driver = await this.prisma.driver.findUnique({
      where: {
        id: driverId,
      },
      include: {
        branch: true,
        User: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    return driver;
  }

  async *streamDriversForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any> {
    const normalizedSearch = search ? search.trim().toLowerCase() : "";
    const orConditions: any[] = [];

    if (normalizedSearch) {
      const digitSearch = normalizedSearch.replace(/\D/g, "");
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { name: { contains: normalizedSearch, mode: "insensitive" } },
        { cnh: { contains: normalizedSearch, mode: "insensitive" } },
        { city: { contains: normalizedSearch, mode: "insensitive" } },
        { uf: { contains: normalizedSearch, mode: "insensitive" } },
        { street: { contains: normalizedSearch, mode: "insensitive" } },
        { branchId: { contains: normalizedSearch, mode: "insensitive" } },
        ...(userRole === "MASTER"
          ? [
              {
                businessId: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ]
          : []),
        ...(digitSearch
          ? [
              { cpf: { contains: digitSearch, mode: "insensitive" } },
              { cep: { contains: digitSearch, mode: "insensitive" } },
              { rg: { contains: digitSearch, mode: "insensitive" } },
            ]
          : []),
      );
    }

    const whereCondition: any = {
      ...(userRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const batchSize = 1000;
    let cursor: string | undefined = undefined;

    while (true) {
      const drivers: any = await this.prisma.driver.findMany({
        where: whereCondition,
        include: {
          branch: { select: { corporate_reason: true } },
          business: { select: { corporate_reason: true } },
        },
        orderBy: { id: "asc" },
        take: batchSize,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
      });

      if (drivers.length === 0) break;
      for (const d of drivers) {
        yield {
          id: d.id,
          name: d.name,
          birth_date: d.birth_date,
          cnh: d.cnh,
          cpf: d.cpf,
          rg: d.rg,
          cep: d.cep,
          city: d.city,
          uf: d.uf,
          street: d.street,
          address_number: d.address_number,
          complement: d.complement,
          status: d.status,
          contract_type: d.contract_type,
          branchId: d.branchId,
          branchName: d.branch?.corporate_reason || null,
          businessId: d.businessId,
          ...(userRole === "MASTER"
            ? { businessName: d.business.corporate_reason }
            : {}),
          created_at: d.created_at,
          updated_at: d.updated_at,
        };
      }

      cursor = drivers[drivers.length - 1].id;
    }
  }

  async searchDriverWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchDriverWithCursorProps): Promise<CursorPaginatedDriver> {
    const items = await this.prisma.driver.findMany({
      where: { businessId },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      orderBy: {
        created_at: "desc",
      },
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countDriversForExport(
    businessId: string,
    userRole: string,
  ): Promise<number> {
    const whereCondition: any = {
      ...(userRole !== "MASTER" && { businessId }),
    };

    const driverCount = await this.prisma.driver.count({
      where: whereCondition,
    });

    return driverCount;
  }
}

export { DriverRepository };
