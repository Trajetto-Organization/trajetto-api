import {
  Driver,
  CreateDriverProps,
  ListDriverProps,
  ListDriverByBusinessIdProps,
  UpdateDriver,
  SearchDriverWithCursorProps,
  CursorPaginatedDriver,
} from "../dtos/driver-dto";

interface IDriverRepository {
  createDriver: (driverData: CreateDriverProps) => Promise<Driver>;
  listDrivers: (
    listDriverProps: ListDriverByBusinessIdProps,
  ) => Promise<ListDriverProps>;
  updateDriver: ({ driverData, driverId }: UpdateDriver) => Promise<Driver>;
  deleteDriver: (driverId: string) => Promise<Driver>;
  findDriverById: (driverId: string) => Promise<Driver | null>;
  findDriverByCpf: (cpf: string) => Promise<Driver | null>;
  findDriverByRg: (rg: string) => Promise<Driver | null>;
  findDriverByDriverLicense: (cnh: string) => Promise<Driver | null>;
  findDriverWithUser: (driverId: string) => Promise<
    | (Driver & {
        user?: { id: string; email: string; name: string } | null;
      })
    | null
  >;
  streamDriversForExport: (
    businessId: string,
    userRole: string,
    search?: string,
  ) => AsyncGenerator<any>;
  searchDriverWithCursor: (
    props: SearchDriverWithCursorProps,
  ) => Promise<CursorPaginatedDriver>;
}

export { IDriverRepository };
