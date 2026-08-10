import { v7 as uuidV7 } from "uuid";
import { IDriverRepository } from "../IDriver-repository";

import {
  Driver,
  CreateDriverProps,
  ListDriverProps,
  ListDriverByBusinessIdProps,
  UpdateDriver,
  SearchDriverWithCursorProps,
  CursorPaginatedDriver,
} from "../../dtos/driver-dto";

class InMemoryDriverRepository implements IDriverRepository {
  public drivers: Driver[] = [];

  async createDriver(driverData: CreateDriverProps): Promise<Driver> {
    const newDriver: Driver = {
      id: uuidV7(),
      ...driverData,
      complement: driverData.complement || null,
      branchId: driverData.branchId || null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.drivers.push(newDriver);
    return newDriver;
  }

  async listDrivers({
    page,
    pageSize,
    businessId,
    search,
  }: ListDriverByBusinessIdProps): Promise<ListDriverProps> {
    let filteredDrivers = this.drivers.filter(
      (driver) => driver.businessId === businessId,
    );

    if (search) {
      const searchLower = search.toLowerCase();
      filteredDrivers = filteredDrivers.filter(
        (driver) =>
          driver.name.toLowerCase().includes(searchLower) ||
          driver.cpf.toLowerCase().includes(searchLower) ||
          driver.cnh.toLowerCase().includes(searchLower) ||
          driver.rg.toLowerCase().includes(searchLower),
      );
    }

    const skip = (page - 1) * pageSize;
    const data = filteredDrivers.slice(skip, skip + pageSize);

    const total = filteredDrivers.length;
    return { data, total };
  }

  async updateDriver({ driverData, driverId }: UpdateDriver): Promise<Driver> {
    const index = this.drivers.findIndex((driver) => driver.id === driverId);

    const filteredData = Object.fromEntries(
      Object.entries(driverData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    const updatedDriver: Driver = {
      ...this.drivers[index],
      ...filteredData,
      updated_at: new Date(),
    };

    this.drivers[index] = updatedDriver;
    return updatedDriver;
  }

  async deleteDriver(driverId: string): Promise<Driver> {
    const index = this.drivers.findIndex((driver) => driver.id === driverId);
    const deletedDriver = this.drivers.splice(index, 1)[0];

    return deletedDriver;
  }

  async findDriverById(driverId: string): Promise<Driver | null> {
    const found = this.drivers.find((driver) => driver.id === driverId);
    return found || null;
  }

  async findDriverByCpf(cpf: string): Promise<Driver | null> {
    const found = this.drivers.find((driver) => driver.cpf === cpf);
    return found || null;
  }

  async findDriverByRg(rg: string): Promise<Driver | null> {
    const found = this.drivers.find((driver) => driver.rg === rg);
    return found || null;
  }

  async findDriverByDriverLicense(cnh: string): Promise<Driver | null> {
    const found = this.drivers.find((driver) => driver.cnh === cnh);
    return found || null;
  }

  async findDriverWithUser(
    driverId: string,
  ): Promise<
    | (Driver & { user?: { id: string; email: string; name: string } | null })
    | null
  > {
    const found = this.drivers.find((driver) => driver.id === driverId);

    if (!found) {
      return null;
    }

    return found || null;
  }

  async *streamDriversForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any> {
    let filtered =
      userRole === "MASTER"
        ? [...this.drivers]
        : this.drivers.filter((driver) => driver.businessId === businessId);

    if (search) {
      const searchTerm = search.toLowerCase();
      filtered = filtered.filter(
        (driver) =>
          driver.id.toLowerCase().includes(searchTerm) ||
          driver.name.toLowerCase().includes(searchTerm) ||
          driver.cnh.toLowerCase().includes(searchTerm) ||
          driver.cpf.includes(searchTerm) ||
          driver.rg.includes(searchTerm) ||
          driver.city.toLowerCase().includes(searchTerm) ||
          driver.uf.toLowerCase().includes(searchTerm) ||
          driver.street.toLowerCase().includes(searchTerm),
      );
    }

    for (const driver of filtered) {
      yield {
        id: driver.id,
        name: driver.name,
        birth_date: driver.birth_date,
        cnh: driver.cnh,
        cpf: driver.cpf,
        rg: driver.rg,
        cep: driver.cep,
        city: driver.city,
        uf: driver.uf,
        street: driver.street,
        address_number: driver.address_number,
        complement: driver.complement,
        status: driver.status,
        contract_type: driver.contract_type,
        branchId: driver.branchId,
        branchName: null,
        businessId: driver.businessId,
        ...(userRole === "MASTER" ? { businessName: null } : {}),
        created_at: driver.created_at,
        updated_at: driver.updated_at,
      };
    }
  }

  async searchDriverWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchDriverWithCursorProps): Promise<CursorPaginatedDriver> {
    let filtered = this.drivers.filter(
      (driver) =>
        driver.businessId === businessId && driver.status === "ACTIVE",
    );

    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter((driver) =>
        [driver.name, driver.cnh].some((value) =>
          value.toLowerCase().includes(term),
        ),
      );
    }

    if (cursor) {
      const cursorIndex = filtered.findIndex((d) => d.id === cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit).map((driver) => ({
      id: driver.id,
      name: driver.name,
      cnh: driver.cnh,
      branchId: driver.branchId,
      businessId: driver.businessId,
      status: driver.status,
      created_at: driver.created_at,
    }));
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countDriversForExport(
    businessId: string,
    userRole: string,
  ): Promise<number> {
    const filteredDrivers =
      userRole === "MASTER"
        ? this.drivers
        : this.drivers.filter((driver) => driver.businessId === businessId);

    return filteredDrivers.length;
  }
}

export { InMemoryDriverRepository };
