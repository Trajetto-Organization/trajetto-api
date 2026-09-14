import { Prisma } from "@prisma/client";

import {
  Fuel,
  CreateFuelProps,
  ListFuelProps,
  ListFuelByBusinessIdProps,
  UpdateFuel,
  GetFuelByIdAndBusinessProps,
  SearchFuelByVehicleWithCursorProps,
  CursorPaginatedFuel,
} from "../dtos/fuel-dto";

interface IFuelRepository {
  createFuel: (fuelData: CreateFuelProps) => Promise<Fuel>;
  createFuelWithMileage: (
    fuelData: CreateFuelProps,
    afterCreate?: (tx: Prisma.TransactionClient, fuel: Fuel) => Promise<void>,
  ) => Promise<{ fuel: Fuel; created: boolean }>;
  findBySubmissionId: (
    businessId: string,
    clientSubmissionId: string,
  ) => Promise<Fuel | null>;
  listFuels: (
    listFuelProps: ListFuelByBusinessIdProps,
  ) => Promise<ListFuelProps>;
  updateFuel: ({ fuelData, fuelId }: UpdateFuel) => Promise<Fuel>;
  updateFuelAndMileage: (
    update: UpdateFuel,
    mileageUpdate?: {
      businessId: string;
      vehicleId: string;
      currentMileage: number;
    },
  ) => Promise<Fuel>;
  deleteFuel: (fuelId: string) => Promise<Fuel>;
  findFuelById: (fuelId: string) => Promise<Fuel | null>;
  findFuelByIdWithRelations: (fuelId: string) => Promise<any | null>;
  getFuelByIdAndBusiness({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<Fuel | null>;
  getFuelByIdAndBusinessWithRelations({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<any | null>;
  findFuelsByVehicleId: (vehicleId: string) => Promise<Fuel[]>;
  findFuelsByDriverId: (driverId: string) => Promise<Fuel[]>;
  findFuelsByFuelTypeId: (fuelTypeId: string) => Promise<Fuel[]>;
  streamFuelsForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any>;
  getPreviousFuelByVehicleId: (
    vehicleId: string,
    currentFuelDate: Date | string,
  ) => Promise<Fuel | null>;
  searchFuelByVehicleWithCursor: (
    props: SearchFuelByVehicleWithCursorProps,
  ) => Promise<CursorPaginatedFuel>;
  countFuelForExport: (businessId: string, userRole: string) => Promise<number>;
}

export { IFuelRepository };
