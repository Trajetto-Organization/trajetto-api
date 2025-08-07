import { inject, injectable } from "tsyringe";
import * as XLSX from "xlsx";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFineRepository } from "../../repositories/IFine-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

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

    try {
      // Get all fines for export using dedicated method
      const fines = await this.fine.getAllFinesForExport(
        findUser.businessId as string,
        findUser.role,
        search,
      );

      // Prepare data for Excel
      const excelData = fines.map((fine) => ({
        ID: fine.id,
        "Placa do Veículo": fine.vehicleLicensePlate || "N/A",
        Motorista: fine.driverName || "N/A",
        "CPF do Motorista": fine.driverCpf || "N/A",
        "Código da Infração": fine.violationCode || "N/A",
        "Descrição da Infração": fine.violationDescription || "N/A",
        "Valor da Multa": fine.amount ? fine.amount : "N/A",
        Pontos: fine.points || 0,
        "Data da Infração": fine.violation_date
          ? new Date(fine.violation_date).toLocaleDateString("pt-BR")
          : "N/A",
        "Data de Vencimento": fine.due_date
          ? new Date(fine.due_date).toLocaleDateString("pt-BR")
          : "N/A",
        "Data de Pagamento": fine.payment_date
          ? new Date(fine.payment_date).toLocaleDateString("pt-BR")
          : "Não pago",
        Filial: fine.branchName || "N/A",
        Local: fine.location || "N/A",
        Observações: fine.observation || "N/A",
        "Criado em": new Date(fine.created_at).toLocaleDateString("pt-BR"),
        "Atualizado em": new Date(fine.updated_at).toLocaleDateString("pt-BR"),
      }));

      // Create workbook
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelData);

      // Set column widths
      const columnWidths = [
        { wch: 10 }, // ID
        { wch: 15 }, // Vehicle Plate
        { wch: 25 }, // Driver
        { wch: 18 }, // Driver's CPF
        { wch: 18 }, // Infraction Code
        { wch: 40 }, // Description of the Violation
        { wch: 15 }, // Value of the Fine
        { wch: 8 }, // Points
        { wch: 18 }, // Date of Violation
        { wch: 18 }, // Expiration Date
        { wch: 18 }, // Payment Date
        { wch: 20 }, // Branch
        { wch: 20 }, // Enterprise
        { wch: 25 }, // Location
        { wch: 30 }, // Observations
        { wch: 15 }, // Created in
      ];

      worksheet["!cols"] = columnWidths;

      // Add worksheet to workbook
      XLSX.utils.book_append_sheet(workbook, worksheet, "Relatório de Multas");

      // Generate Excel file buffer
      const excelBuffer = XLSX.write(workbook, {
        type: "buffer",
        bookType: "xlsx",
      });

      return {
        buffer: excelBuffer,
        filename: `relatorio-multas-${new Date().toISOString().split("T")[0]}.xlsx`,
        totalRecords: fines.length,
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar gerar o relatório Excel das multas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ExportFineExcelUseCase };
