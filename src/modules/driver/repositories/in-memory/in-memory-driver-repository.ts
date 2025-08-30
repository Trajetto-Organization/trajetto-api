import { v4 as uuidV4 } from "uuid";

import { IDriverRepository } from "../IDriver-repository";
import {
  Driver,
  CreateDriverProps,
  ListDriverProps,
  ListDriverByBusinessIdProps,
  UpdateDriver,
  ListDriverBusinessProps,
} from "../../dtos/driver-dto";

class InMemoryDriverRepository implements IDriverRepository {
  public drivers: Driver[] = [];

  async createDriver(driverData: CreateDriverProps): Promise<Driver> {
    const newDriver: Driver = {
      id: uuidV4(),
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
    currentUserRole,
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

  async listDriverBusiness({
    page,
    pageSize,
    businessId,
  }: ListDriverBusinessProps): Promise<ListDriverProps> {
    const filteredDrivers = this.drivers.filter(
      (driver) => driver.businessId === businessId,
    );

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
}

export { InMemoryDriverRepository };
