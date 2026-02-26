import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFineRepository } from "../../repositories/IFine-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  ExcelExportService,
  ExcelColumn,
} from "@/shared/services/excel-export-service";

@injectable()
class ExportFineExcelUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
  ) {}

  async execute(userId: string, search?: string) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Get all fines for export using dedicated method
    const fines = await this.fine.getAllFinesForExport(
      findUser.businessId as string,
      findUser.role,
      search,
    );

    // Define columns configuration for fines
    const columns: ExcelColumn[] = [
      { header: "ID", key: "id", width: 10 },
      { header: "Placa do Veículo", key: "vehicleLicensePlate", width: 15 },
      { header: "Motorista", key: "driverName", width: 25 },
      {
        header: "CPF do Motorista",
        key: "driverCpf",
        width: 18,
        formatter: ExcelExportService.formatters.cpf,
      },
      { header: "Código da Infração", key: "violationCode", width: 18 },
      {
        header: "Descrição da Infração",
        key: "violationDescription",
        width: 40,
      },
      { header: "Valor da Multa", key: "amount", width: 15 },
      { header: "Pontos", key: "points", width: 8 },
      {
        header: "Data da Infração",
        key: "violation_date",
        width: 18,
        formatter: ExcelExportService.formatters.date,
      },
      {
        header: "Data de Vencimento",
        key: "due_date",
        width: 18,
        formatter: ExcelExportService.formatters.date,
      },
      {
        header: "Data de Pagamento",
        key: "payment_date",
        width: 18,
        formatter: (value) =>
          value ? ExcelExportService.formatters.date(value) : "Não pago",
      },
      { header: "Latitude", key: "latitude", width: 30 },
      { header: "Longitude", key: "longitude", width: 30 },
      { header: "Filial", key: "branchName", width: 20 },
      ...(findUser.role === "MASTER"
        ? [{ header: "Empresa", key: "businessName", width: 25 }]
        : []),
      { header: "Local", key: "location", width: 25 },
      { header: "Observações", key: "observation", width: 30 },
      {
        header: "Criado em",
        key: "created_at",
        width: 20,
        formatter: ExcelExportService.formatters.notificationDateTime,
      },
      {
        header: "Atualizado em",
        key: "updated_at",
        width: 20,
        formatter: ExcelExportService.formatters.notificationDateTime,
      },
    ];

    // Use the generic Excel export service
    return ExcelExportService.execute({
      data: fines,
      columns,
      sheetName: "Relatório de Multas",
      filename: `relatorio-multas-${new Date().toISOString().split("T")[0]}`,
    });
  }
}

export { ExportFineExcelUseCase };
