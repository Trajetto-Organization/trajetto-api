import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFuelRepository } from "../../repositories/IFuel-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  ExcelExportService,
  ExcelColumn,
} from "@/shared/services/excel-export-service";

@injectable()
class ExportFuelExcelUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FuelRepository")
    private fuel: IFuelRepository,
  ) {}

  async execute(userId: string, search?: string) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Get all fuels for export using dedicated method
    const fuels = await this.fuel.getAllFuelsForExport(
      findUser.businessId as string,
      findUser.role,
      search,
    );

    // Define columns configuration for fuels
    const columns: ExcelColumn[] = [
      { header: "ID", key: "id", width: 10 },
      { header: "Placa do Veículo", key: "vehicleLicensePlate", width: 15 },
      { header: "Descrição do Veículo", key: "vehicleDescription", width: 25 },
      { header: "Marca", key: "vehicleBrand", width: 15 },
      { header: "Modelo", key: "vehicleModel", width: 15 },
      { header: "Motorista", key: "driverName", width: 25 },
      {
        header: "CNH do Motorista",
        key: "driverCnh",
        width: 18,
      },
      { header: "Tipo de Combustível", key: "fuelTypeDescription", width: 20 },
      {
        header: "Litros Abastecidos",
        key: "litersAmount",
        width: 18,
        formatter: (value) => value?.toString().replace(".", ",") || "0,000",
      },
      {
        header: "Preço por Litro",
        key: "pricePerLiter",
        width: 15,
        formatter: ExcelExportService.formatters.currency,
      },
      {
        header: "Valor Total",
        key: "totalAmount",
        width: 15,
        formatter: ExcelExportService.formatters.currency,
      },
      { header: "Quilometragem Atual", key: "currentMileage", width: 18 },
      { header: "Foto do Hodômetro", key: "odometerPhoto", width: 20 },
      { header: "Hodômetro Verificado", key: "odometerVerified", width: 20 },
      { header: "Observações", key: "notes", width: 30 },
      {
        header: "Data do Abastecimento",
        key: "refueling_date",
        width: 20,
        formatter: ExcelExportService.formatters.date,
      },
      { header: "Filial", key: "branchName", width: 20 },
      ...(findUser.role === "MASTER"
        ? [{ header: "Empresa", key: "businessName", width: 25 }]
        : []),
      {
        header: "Criado em",
        key: "created_at",
        width: 15,
        formatter: ExcelExportService.formatters.date,
      },
      {
        header: "Atualizado em",
        key: "updated_at",
        width: 15,
        formatter: ExcelExportService.formatters.date,
      },
    ];

    // Use the generic Excel export service
    return ExcelExportService.execute({
      data: fuels,
      columns,
      sheetName: "Relatório de Abastecimentos",
      filename: `relatorio-abastecimentos-${new Date().toISOString().split("T")[0]}`,
    });
  }
}

export { ExportFuelExcelUseCase };
