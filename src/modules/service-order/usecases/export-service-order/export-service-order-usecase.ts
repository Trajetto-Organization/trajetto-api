import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IServiceOrderRepository } from "../../repositories/IService-order-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ServiceOrderNoServiceOrdersToExportError } from "../errors/service-order-no-service-orders-to-export-error";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

@injectable()
class ExportServiceOrderUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
  ) {}

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

    const total = await this.serviceOrder.countServiceOrderForExport(
      findUser.businessId as string,
      findUser.role,
    );

    if (total === 0) {
      throw new ServiceOrderNoServiceOrdersToExportError();
    }

    const iterator = this.serviceOrder.streamServiceOrdersForExport(
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
        header: "Responsável",
        key: "responsibleUserName",
        width: 25,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "E-mail do Responsável",
        key: "responsibleUserEmail",
        width: 30,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Tipo de Manutenção",
        key: "maintenance_type",
        width: 18,
        formatter: (value) => {
          const types: Record<string, string> = {
            INTERNAL: "Interna",
            EXTERNAL: "Externa",
          };

          return types[value] || value;
        },
      },

      {
        header: "Valor Total",
        key: "total_amount",
        width: 15,
        formatter: ExportFormatters.currency,
      },

      {
        header: "Data",
        key: "date",
        width: 18,
        formatter: ExportFormatters.date,
      },

      {
        header: "Data de Conclusão",
        key: "completion_date",
        width: 18,
        formatter: (value) =>
          value ? ExportFormatters.date(value) : "Pendente",
      },

      {
        header: "Km Atual (Serviço)",
        key: "current_mileage_at_service",
        width: 18,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Nova Km (Após Serviço)",
        key: "new_mileage_after_service",
        width: 20,
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
        header: "Fornecedor",
        key: "supplierName",
        width: 25,
        formatter: (value) => value || "Sem fornecedor",
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

    const filename = `relatorio-ordens-servico-${
      new Date().toISOString().split("T")[0]
    }`;

    return { iterator, columns, filename };
  }
}

export { ExportServiceOrderUseCase };
