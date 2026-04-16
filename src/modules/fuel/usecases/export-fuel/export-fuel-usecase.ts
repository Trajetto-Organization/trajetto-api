import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { FuelNoFuelsToExportError } from "../errors/fuel-no-fuels-to-export-error";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

@injectable()
class ExportFuelUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("FuelRepository")
    private fuelRepository: IFuelRepository,
  ) {}

  /**
   * Prepare iterator (AsyncGenerator) + columns + filename
   */
  async execute(
    userId: string,
    search?: string,
  ): Promise<{
    iterator: AsyncGenerator<any>;
    columns: ExportColumn[];
    filename: string;
  }> {
    const findUser = await this.userRepository.findUserById(userId);
    if (!findUser) throw new ResourceNotFoundError();

    const total = await this.fuelRepository.countFuelForExport(
      findUser.businessId as string,
      findUser.role,
    );

    if (total === 0) {
      throw new FuelNoFuelsToExportError();
    }

    const iterator = this.fuelRepository.streamFuelsForExport(
      findUser.businessId!,
      findUser.role,
      search,
    );

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
        formatter: ExportFormatters.date,
      },

      {
        header: "Filial",
        key: "branchName",
        width: 25,
        formatter: ExportFormatters.fallback,
      },

      ...(findUser.role === "MASTER"
        ? [
            {
              header: "Empresa",
              key: "businessName",
              width: 25,
              formatter: ExportFormatters.fallback,
            },
          ]
        : []),

      {
        header: "Criado em",
        key: "created_at",
        width: 20,
        formatter: ExportFormatters.datetime,
      },

      {
        header: "Atualizado em",
        key: "updated_at",
        width: 20,
        formatter: ExportFormatters.datetime,
      },
    ];

    const filename = `relatorio-abastecimentos-${
      new Date().toISOString().split("T")[0]
    }`;

    return { iterator, columns, filename };
  }
}

export { ExportFuelUseCase };
