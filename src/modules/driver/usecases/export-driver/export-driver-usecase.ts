import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "../../repositories/IDriver-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { DriverNoDriversToExportError } from "../errors/driver-no-drivers-to-export-error";

import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

import type { DriverExportFilters } from "../../dtos/driver-dto";

type ExportDriverRequest = Omit<DriverExportFilters, "businessId"> & {
  userId: string;
  /** MASTER picks the company; everyone else is pinned to their own. */
  businessId?: string;
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Ativo",
  INACTIVE: "Inativo",
};

const CONTRACT_LABELS: Record<string, string> = {
  OWNED: "Próprio",
  THIRD_PARTY: "Terceirizado",
};

/**
 * A civil date — the CNH expiry (`@db.Date`) and the birth date (stored as UTC
 * midnight of the day): read in UTC, printed without a time. The server's zone
 * would print the day before on a machine west of UTC.
 */
const civilDate = (value?: Date | string | null) =>
  value
    ? new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(
        new Date(value),
      )
    : "N/A";

/**
 * The drivers of ONE company, filtered and ordered exactly as the list on
 * screen (decision 5.8): the same search, the same filters, the same sort.
 * The MASTER used to download every carrier's drivers in one file.
 */
@injectable()
class ExportDriverUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    businessId,
    ...filters
  }: ExportDriverRequest): Promise<{
    iterator: AsyncGenerator<any>;
    columns: ExportColumn[];
    filename: string;
  }> {
    const findUser = await this.user.findUserById(userId);
    if (!findUser) throw new ResourceNotFoundError();

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    const findBusiness =
      await this.business.findBusinessById(resolvedBusinessId);

    if (!findBusiness) throw new BusinessNotFoundError();

    // The rows the file would carry, not the company's total: a filter that
    // keeps nothing is refused like accounts payable, fuel and the others.
    const { sort: _sort, order: _order, ...where } = filters;
    const total = await this.driver.countDriversForExport({
      ...where,
      businessId: resolvedBusinessId,
    });

    if (total === 0) {
      throw new DriverNoDriversToExportError();
    }

    const timeZone = resolveTimeZone(findBusiness.timezone);

    // Instants in the company's zone: the file is read by people there.
    const instant = (value?: Date | string | null) =>
      value
        ? new Intl.DateTimeFormat("pt-BR", {
            dateStyle: "short",
            timeStyle: "short",
            timeZone,
          }).format(new Date(value))
        : "N/A";

    const iterator = this.driver.streamDriversForExport({
      ...filters,
      businessId: resolvedBusinessId,
    });

    const columns: ExportColumn[] = [
      {
        header: "ID",
        key: "id",
        width: 10,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Nome",
        key: "name",
        width: 30,
        formatter: ExportFormatters.fallback,
      },
      { header: "CPF", key: "cpf", width: 18, formatter: ExportFormatters.cpf },
      {
        header: "RG",
        key: "rg",
        width: 15,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "CNH",
        key: "cnh",
        width: 15,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Categoria da CNH",
        key: "cnh_category",
        width: 16,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Validade da CNH",
        key: "cnh_expires_at",
        width: 16,
        formatter: civilDate,
      },
      {
        header: "Data de Nascimento",
        key: "birth_date",
        width: 18,
        formatter: civilDate,
      },
      {
        header: "Status",
        key: "status",
        width: 12,
        formatter: (value) => STATUS_LABELS[value] || value,
      },
      {
        header: "Tipo de Contrato",
        key: "contract_type",
        width: 18,
        formatter: (value) => CONTRACT_LABELS[value] || value,
      },
      {
        header: "CEP",
        key: "cep",
        width: 12,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Cidade",
        key: "city",
        width: 20,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "UF",
        key: "uf",
        width: 5,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Rua",
        key: "street",
        width: 30,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Número",
        key: "address_number",
        width: 10,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Complemento",
        key: "complement",
        width: 20,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Filial",
        key: "branchName",
        width: 20,
        formatter: ExportFormatters.fallback,
      },
      { header: "Criado em", key: "created_at", width: 20, formatter: instant },
      {
        header: "Atualizado em",
        key: "updated_at",
        width: 20,
        formatter: instant,
      },
    ];

    // The company's day: after 21:00 in São Paulo the UTC day is tomorrow.
    const filename = `relatorio-motoristas-${businessDateKey(new Date(), timeZone)}`;

    return { iterator, columns, filename };
  }
}

export { ExportDriverUseCase };
export type { ExportDriverRequest };
