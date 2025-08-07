import {
  Driver,
  CreateDriverProps,
  ListDriverProps,
  ListDriverByBusinessIdProps,
  UpdateDriver,
  ListDriverBusinessProps,
} from "../dtos/driver-dto";

interface IDriverRepository {
  createDriver: (driverData: CreateDriverProps) => Promise<Driver>;
  listDrivers: (
    listDriverProps: ListDriverByBusinessIdProps,
  ) => Promise<ListDriverProps>;
  listDriverBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListDriverBusinessProps) => Promise<ListDriverProps>;
  updateDriver: ({ driverData, driverId }: UpdateDriver) => Promise<Driver>;
  deleteDriver: (driverId: string) => Promise<Driver>;
  findDriverById: (driverId: string) => Promise<Driver | null>;
  findDriverByCpf: (cpf: string) => Promise<Driver | null>;
  findDriverByRg: (rg: string) => Promise<Driver | null>;
  findDriverByDriverLicense: (cnh: string) => Promise<Driver | null>;
}

export { IDriverRepository };
