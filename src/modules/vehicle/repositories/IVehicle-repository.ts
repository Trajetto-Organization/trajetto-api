import {
  Vehicle,
  CreateVehicleProps,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  UpdateVehicle,
  GetVehicleByIdAndBusinessProps,
  SearchVehicleWithCursorProps,
  CursorPaginatedVehicle,
} from "../dtos/vehicle-dto";

interface IVehicleRepository {
  createVehicle: (vehicleData: CreateVehicleProps) => Promise<Vehicle>;

  /**
   * Cria dentro da frota contratada, com a contagem e a inserção na MESMA
   * transação e a empresa travada.
   *
   * Contar e depois criar é um read-then-write, e o limite é um controle de
   * cobrança: N requisições simultâneas liam a mesma contagem, todas passavam,
   * e a empresa terminava acima do contrato. Devolve `vehicle: null` quando o
   * limite bateu, para quem chamou formular a recusa.
   */
  createVehicleWithinLimit: (
    vehicleData: CreateVehicleProps,
    limit: { max: number; occupiesSlot: boolean },
  ) => Promise<{ vehicle: Vehicle | null; activeCount: number }>;
  listVehicles: (
    listVehicleProps: ListVehicleByBusinessIdProps,
  ) => Promise<ListVehicleProps>;
  updateVehicle: ({
    vehicleData,
    vehicleId,
  }: UpdateVehicle) => Promise<Vehicle>;
  deleteVehicle: (vehicleId: string) => Promise<Vehicle>;
  findVehicleById: (vehicleId: string) => Promise<Vehicle | null>;
  findVehicleByLicensePlate: (licensePlate: string) => Promise<Vehicle | null>;
  findVehicleByRenavam: (renavam: string) => Promise<Vehicle | null>;
  getVehicleByIdAndBusiness({
    businessId,
    vehicleId,
  }: GetVehicleByIdAndBusinessProps): Promise<Vehicle | null>;
  findVehiclesByFuelTypeId: (fuelTypeId: string) => Promise<Vehicle[]>;
  streamVehiclesForExport: (
    businessId: string,
    userRole: string,
    search?: string,
  ) => AsyncGenerator<any>;
  searchVehicleWithCursor: (
    props: SearchVehicleWithCursorProps,
  ) => Promise<CursorPaginatedVehicle>;
  countVehiclesForExport: (
    businessId: string,
    userRole: string,
  ) => Promise<number>;
  countActiveVehiclesByBusinessId: (businessId: string) => Promise<number>;
  countInactiveVehiclesByBusinessId: (businessId: string) => Promise<number>;
}

export { IVehicleRepository };
