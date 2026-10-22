import { inject, injectable } from "tsyringe";
import { AppError } from "@/shared/errors/AppError";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { FuelNoFuelsToExportError } from "../errors/fuel-no-fuels-to-export-error";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { businessDateKey } from "@/shared/time/business-day";
import { businessTimeZone } from "../fuel-rules";
import { formatInstant, formatPickedDay } from "@/shared/vehicle/record-dates";

interface ExportFuelRequest {
  userId: string;
  businessId?: string;
  search?: string;
  branchIds?: string[];
  vehicleIds?: string[];
  fuelTypeIds?: string[];
}

@injectable()
class ExportFuelUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("FuelRepository")
    private fuelRepository: IFuelRepository,
    @inject("BusinessRepository")
    private businessRepository: IBusinessRepository,
  ) {}

  /**
   * Prepare iterator (AsyncGenerator) + columns + filename.
   *
   * The same company resolution and the same filters as the list (decision
   * 5.8): the MASTER names the company he is looking at, and the file holds
   * what the screen filtered — search and every facet.
   */
  async execute({
    userId,
    businessId,
    search,
    branchIds,
    vehicleIds,
    fuelTypeIds,
  }: ExportFuelRequest): Promise<{
    iterator: AsyncGenerator<any>;
    columns: ExportColumn[];
    filename: string;
  }> {
    const findUser = await this.userRepository.findUserById(userId);
    if (!findUser) throw new ResourceNotFoundError();

    // Drivers hold fuel and checklist WRITE so the app can submit their own
    // records. An export is the back office reading the whole company —
    // every driver, CNH, value and position — which that grant never meant.
    if (findUser.driverId) {
      throw new AppError(
        "Motoristas não exportam dados da frota.",
        403,
        "DRIVER_CANNOT_EXPORT",
      );
    }

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    const filters = {
      businessId: resolvedBusinessId,
      search,
      branchIds,
      vehicleIds,
      fuelTypeIds,
    };

    const total = await this.fuelRepository.countFuelForExport(filters);

    if (total === 0) {
      throw new FuelNoFuelsToExportError();
    }

    const business =
      await this.businessRepository.findBusinessById(resolvedBusinessId);

    // The company's zone (decision 1.1): the shared formatters printed in the
    // server's (UTC), a day ahead from 21:00 in São Paulo.
    const timeZone = businessTimeZone(business);

    const iterator = this.fuelRepository.streamFuelsForExport(filters);

    const columns: ExportColumn[] = [
      {
        header: "ID",
        key: "id",
        width: 10,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Placa do Veículo",
        key: "vehicleLicensePlate",
        width: 15,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Descrição do Veículo",
        key: "vehicleDescription",
        width: 25,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Marca",
        key: "vehicleBrand",
        width: 15,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Modelo",
        key: "vehicleModel",
        width: 15,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Motorista",
        key: "driverName",
        width: 25,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "CNH do Motorista",
        key: "driverCnh",
        width: 18,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Tipo de Combustível",
        key: "fuelTypeDescription",
        width: 20,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Litros Abastecidos",
        key: "litersAmount",
        width: 18,
        formatter: ExportFormatters.number3,
      },

      {
        header: "Preço por Litro",
        key: "pricePerLiter",
        width: 15,
        formatter: ExportFormatters.currency,
      },

      {
        header: "Valor Total",
        key: "totalAmount",
        width: 15,
        formatter: ExportFormatters.currency,
      },

      {
        header: "Quilometragem Atual",
        key: "currentMileage",
        width: 18,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Odômetro Verificado",
        key: "odometerVerified",
        width: 20,
        formatter: ExportFormatters.booleanSimNao,
      },

      {
        header: "Observações",
        key: "notes",
        width: 30,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Latitude",
        key: "latitude",
        width: 20,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Longitude",
        key: "longitude",
        width: 20,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Data do Abastecimento",
        key: "refueling_date",
        width: 20,
        // A timestamp that means a day: the app sends the moment, a bare
        // "YYYY-MM-DD" is 00:00 UTC (see record-dates).
        formatter: (value) => formatPickedDay(value, timeZone),
      },

      {
        header: "Filial",
        key: "branchName",
        width: 25,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Criado em",
        key: "created_at",
        width: 20,
        formatter: (value) => formatInstant(value, timeZone),
      },

      {
        header: "Atualizado em",
        key: "updated_at",
        width: 20,
        formatter: (value) => formatInstant(value, timeZone),
      },
    ];

    // Dated with the company's day: the UTC day named tomorrow's file from
    // 21:00 in São Paulo.
    const filename = `relatorio-abastecimentos-${businessDateKey(
      new Date(),
      timeZone,
    )}`;

    return { iterator, columns, filename };
  }
}

export { ExportFuelUseCase };
export type { ExportFuelRequest };
