import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IServiceOrderRepository } from "../../repositories/IService-order-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { ServiceOrderNoServiceOrdersToExportError } from "../errors/service-order-no-service-orders-to-export-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { AppError } from "@/shared/errors/AppError";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";

import type { ServiceOrderListQuery } from "../../dtos/service-order-dto";

type ExportServiceOrderFilters = Omit<ServiceOrderListQuery, "businessId">;

/** Day and day-with-time as the company reads them, "N/A" when empty. */
function zonedExportFormatters(timeZone: string) {
  const day = new Intl.DateTimeFormat("pt-BR", { timeZone });
  const dayAndTime = new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  });

  return {
    date: (value?: Date | string | null) =>
      value ? day.format(new Date(value)) : "N/A",
    dateTime: (value?: Date | string | null) =>
      value ? dayAndTime.format(new Date(value)) : "N/A",
  };
}

@injectable()
class ExportServiceOrderUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
  ) {}

  /**
   * The rows the listing shows, as a file (decision 5.8): the same search and
   * filters, one company — the MASTER names it, like on the screen, instead
   * of receiving every tenant mixed in one sheet.
   */
  async execute(
    userId: string,
    filters: ExportServiceOrderFilters,
    requestedBusinessId?: string,
  ): Promise<{
    iterator: AsyncGenerator<any>;
    columns: ExportColumn[];
    filename: string;
  }> {
    const findUser = await this.user.findUserById(userId);
    if (!findUser) throw new ResourceNotFoundError();

    const businessId = requestedBusinessId ?? findUser.businessId;

    if (!businessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, businessId);

    const business = await this.business.findBusinessById(businessId);
    if (!business) throw new BusinessNotFoundError();

    const query: ServiceOrderListQuery = { ...filters, businessId };

    const total = await this.serviceOrder.countServiceOrderForExport(query);

    if (total === 0) {
      throw new ServiceOrderNoServiceOrdersToExportError();
    }

    const iterator = this.serviceOrder.streamServiceOrdersForExport(query);

    // The company's zone, for the file name and every date in it: the shared
    // formatters read the container's clock (UTC), which put "Criado em"
    // three hours ahead in São Paulo and an order dated late in the evening
    // on the next day (decision 1.2).
    // The DTO predates the column; the row carries it.
    const timeZone = resolveTimeZone(
      (business as { timezone?: string | null }).timezone,
    );

    const { date, dateTime } = zonedExportFormatters(timeZone);

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
        header: "Total das Peças",
        key: "parts_total",
        width: 15,
        formatter: ExportFormatters.currency,
      },

      {
        header: "Descrição",
        key: "description",
        width: 30,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Data",
        key: "date",
        width: 18,
        formatter: date,
      },

      {
        header: "Data de Conclusão",
        key: "completion_date",
        width: 18,
        formatter: (value) => (value ? date(value) : "Pendente"),
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

      {
        header: "Criado em",
        key: "created_at",
        width: 20,
        formatter: dateTime,
      },

      {
        header: "Atualizado em",
        key: "updated_at",
        width: 20,
        formatter: dateTime,
      },
    ];

    // The company's calendar day: after 21:00 in São Paulo the UTC day is
    // already tomorrow.
    const filename = `relatorio-ordens-servico-${businessDateKey(
      new Date(),
      timeZone,
    )}`;

    return { iterator, columns, filename };
  }
}

export { ExportServiceOrderUseCase, zonedExportFormatters };
