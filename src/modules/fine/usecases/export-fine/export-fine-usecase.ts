import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IFineRepository } from "../../repositories/IFine-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

import { businessDateKey, businessDayRange } from "@/shared/time/business-day";
import { loadBusinessTimeZone } from "@/shared/time/business-time-zone";

import type { FineExportRow } from "../../dtos/fine-dto";
import type { FineStatus } from "../list-fine/fine-list";

interface ExportFineRequest {
  userId: string;
  businessId?: string;
  search?: string;
  statuses?: FineStatus[];
  branchIds?: string[];
  trafficViolationCodeIds?: string[];
  now?: Date;
}

const STATUS_LABELS: Record<FineStatus, string> = {
  PAID: "Paga",
  PENDING: "A vencer",
  OVERDUE: "Vencida",
};

/**
 * The fines file: the rows the list shows with the same search and
 * filters (decision 5.8), for one company. The MASTER used to export every
 * company at once whatever was selected on screen; now he names the one.
 *
 * Dates and times read in the company's zone. The shared formatters use
 * the server's clock, which runs in UTC: "Criado em" came out three hours
 * ahead in São Paulo.
 */
@injectable()
class ExportFineUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
  ) {}

  async execute({
    userId,
    businessId,
    search,
    statuses,
    branchIds,
    trafficViolationCodeIds,
    now = new Date(),
  }: ExportFineRequest): Promise<{
    iterator: AsyncGenerator<FineExportRow>;
    columns: ExportColumn[];
    filename: string;
  }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para exportar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    const timeZone = await loadBusinessTimeZone(
      this.business,
      resolvedBusinessId,
    );

    const query = {
      businessId: resolvedBusinessId,
      search,
      statuses,
      branchIds,
      trafficViolationCodeIds,
      todayStart: businessDayRange(now, timeZone).start,
    };

    // The same filters as the file: "nothing to export" means nothing the
    // screen shows, not an empty company.
    const total = await this.fine.countFinesForExport(query);

    if (total === 0) {
      throw new AppError(
        "Não existem multas para exportar com a busca e os filtros atuais.",
        400,
        "NO_FINES_TO_EXPORT",
      );
    }

    const day = new Intl.DateTimeFormat("pt-BR", { timeZone });
    const dayAndTime = new Intl.DateTimeFormat("pt-BR", {
      timeZone,
      dateStyle: "short",
      timeStyle: "short",
    });

    const date = (value?: Date | null) =>
      value ? day.format(new Date(value)) : "N/A";
    const dateTime = (value?: Date | null) =>
      value ? dayAndTime.format(new Date(value)) : "N/A";

    const columns: ExportColumn[] = [
      {
        header: "ID",
        key: "id",
        width: 38,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Situação",
        key: "status",
        width: 12,
        formatter: (value: FineStatus) => STATUS_LABELS[value] ?? "N/A",
      },
      {
        header: "Placa do Veículo",
        key: "vehicleLicensePlate",
        width: 15,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Veículo",
        key: "vehicleDescription",
        width: 25,
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
        formatter: date,
      },
      {
        header: "Data de Vencimento",
        key: "due_date",
        width: 18,
        formatter: date,
      },
      {
        header: "Data de Pagamento",
        key: "payment_date",
        width: 18,
        formatter: (value?: Date | null) => (value ? date(value) : "Não paga"),
      },
      {
        header: "Filial",
        key: "branchName",
        width: 25,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Local",
        key: "location",
        width: 25,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Latitude",
        key: "latitude",
        width: 14,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Longitude",
        key: "longitude",
        width: 14,
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
        formatter: dateTime,
      },
      {
        header: "Atualizado em",
        key: "updated_at",
        width: 20,
        formatter: dateTime,
      },
    ];

    // Dated with the company's day: the UTC day named tomorrow's file from
    // 21:00 in São Paulo.
    const filename = `relatorio-multas-${businessDateKey(now, timeZone)}`;

    return {
      iterator: this.fine.streamFinesForExport(query),
      columns,
      filename,
    };
  }
}

export { ExportFineUseCase };
export type { ExportFineRequest };
