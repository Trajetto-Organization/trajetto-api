import { IDriverRepository } from "./IDriver-repository";
import {
  Driver,
  CreateDriverProps,
  ListDriverByBusinessIdProps,
  ListDriverProps,
  UpdateDriver,
  ListDriverBusinessProps,
} from "../dtos/driver-dto";

import database from "@/../infra/database";
import {
  formatDate,
  formatCpf,
  formatCep,
  formatRg,
} from "@/config/format-values";

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

    const driverData = await this.prisma.driver.findMany({
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
    });

    const total = await this.prisma.driver.count({
      where: whereCondition,
    });

    const transformedDriverData = driverData.map((driver) => ({
      id: driver.id ?? "N/A",
      name: driver.name ?? "N/A",
      birth_date: driver.birth_date ?? "N/A",
      cnh: driver.cnh ?? "N/A",
      cpf: formatCpf(driver.cpf) ?? "N/A",
      rg: formatRg(driver.rg) ?? "N/A",
      cep: formatCep(driver.cep) ?? "N/A",
      city: driver.city ?? "N/A",
      uf: driver.uf ?? "N/A",
      street: driver.street ?? "N/A",
      address_number: driver.address_number ?? "N/A",
      complement: driver.complement ?? "N/A",
      status: driver.status ?? "N/A",
      contract_type: driver.contract_type ?? "N/A",
      businessId: driver.businessId ?? "N/A",
      ...(currentUserRole === "MASTER"
        ? { business_name: driver.business?.corporate_reason ?? "N/A" }
        : {}),
      branchId: driver.branchId ?? null,
      branchName: driver.branch?.corporate_reason ?? "N/A",
      created_at: formatDate(driver.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(driver.updated_at, "pt-BR") ?? "N/A",
    }));

    return {
      data: transformedDriverData,
      total,
    };
  }

  async listDriverBusiness({
    page,
    pageSize,
    businessId,
  }: ListDriverBusinessProps): Promise<ListDriverProps> {
    const skip = (page - 1) * pageSize;

    const driverBusinessData = await this.prisma.driver.findMany({
      skip,
      take: pageSize,
      where: {
        businessId,
      },
    });

    const total = await this.prisma.driver.count({
      where: {
        businessId,
      },
    });

    return { data: driverBusinessData, total };
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
        branch: true,
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
}

export { DriverRepository };
