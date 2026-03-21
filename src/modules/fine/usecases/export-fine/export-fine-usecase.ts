import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IFineRepository } from "../../repositories/IFine-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

@injectable()
class ExportFineUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
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
    const findUser = await this.user.findUserById(userId);
    if (!findUser) throw new ResourceNotFoundError();

    const iterator = this.fine.streamFinesForExport(
      findUser.businessId!,
      findUser.role,
      search,
    );

    // Define columns configuration for fines
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
        header: "Motorista",
        key: "driverName",
        width: 25,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "CPF do Motorista",
        key: "driverCpf",
        width: 18,
        formatter: ExportFormatters.cpf,
      },

      {
        header: "Código da Infração",
        key: "violationCode",
        width: 18,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Descrição da Infração",
        key: "violationDescription",
        width: 40,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Valor da Multa",
        key: "amount",
        width: 15,
        formatter: ExportFormatters.currency,
      },

      {
        header: "Pontos",
        key: "points",
        width: 8,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Data da Infração",
        key: "violation_date",
        width: 18,
        formatter: ExportFormatters.date,
      },

      {
        header: "Data de Vencimento",
        key: "due_date",
        width: 18,
        formatter: ExportFormatters.date,
      },

      {
        header: "Data de Pagamento",
        key: "payment_date",
        width: 18,
        formatter: (value) =>
          value ? ExportFormatters.date(value) : "Não pago",
      },

      {
        header: "Latitude",
        key: "latitude",
        width: 30,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Longitude",
        key: "longitude",
        width: 30,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Filial",
        key: "branchName",
        width: 20,
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
        header: "Local",
        key: "location",
        width: 25,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Observações",
        key: "observation",
        width: 30,
        formatter: ExportFormatters.fallback,
      },

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

    const filename = `relatorio-multas-${
      new Date().toISOString().split("T")[0]
    }`;

    return { iterator, columns, filename };
  }
}

export { ExportFineUseCase };
