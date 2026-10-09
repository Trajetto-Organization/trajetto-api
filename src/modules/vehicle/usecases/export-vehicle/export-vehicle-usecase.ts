import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IVehicleRepository } from "../../repositories/IVehicle-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { VehicleNoVehiclesToExportError } from "../errors/vehicle-no-vehicles-to-export-error";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { AppError } from "@/shared/errors/AppError";

import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";
import { vehicleYearOf } from "@/shared/vehicle/vehicle-years";
import { formatInstant, formatPickedDay } from "@/shared/vehicle/record-dates";
import type { VehicleStatus } from "@/shared/vehicle/vehicle-rules";

interface ExportVehicleRequest {
  userId: string;
  /** The MASTER names the company; everyone else exports their own. */
  businessId?: string;
  search?: string;
  statuses?: VehicleStatus[];
  branchIds?: string[];
}

/** Only the year means anything in these two dates (stored on 1 January). */
const yearOnly = (value?: Date | string | null): string =>
  value ? String(vehicleYearOf(value)) : "N/A";

const kmPerLiter = (value?: number | null): string =>
  value === null || value === undefined
    ? "N/A"
    : value.toLocaleString("pt-BR", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 2,
      });

/**
 * The vehicle table as a file, with the SAME search and filters as the
 * screen (decision 5.8) and for the company on screen — the MASTER's export
 * used to dump every company's fleet into one sheet.
 */
@injectable()
class ExportVehicleUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    businessId,
    search,
    statuses,
    branchIds,
  }: ExportVehicleRequest): Promise<{
    iterator: AsyncGenerator<Record<string, unknown>>;
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

    const findBusiness = await this.business.findBusinessById(resolvedBusinessId);

    if (!findBusiness) throw new BusinessNotFoundError();

    const filters = {
      businessId: resolvedBusinessId,
      search: search?.trim() || undefined,
      statuses,
      branchIds,
    };

    const total = await this.vehicle.countVehiclesForExport(filters);

    if (total === 0) {
      throw new VehicleNoVehiclesToExportError();
    }

    const iterator = this.vehicle.streamVehiclesForExport(filters);

    // The company's day, not the server's: at 22:00 in São Paulo the UTC
    // date is already tomorrow — in the file name and in every date column.
    const timeZone = resolveTimeZone(
      (findBusiness as { timezone?: string | null }).timezone,
    );

    const statusMap: Record<string, string> = {
      ACTIVE: "Ativo",
      INACTIVE: "Inativo",
      BLOCKED: "Bloqueado",
      IN_ROUTE: "Em Rota",
    };

    const fleetTypeMap: Record<string, string> = {
      OWNED: "Próprio",
      THIRD_PARTY: "Terceirizado",
    };

    const columns: ExportColumn[] = [
      {
        header: "ID",
        key: "id",
        width: 10,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Descrição",
        key: "description",
        width: 25,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Placa",
        key: "license_plate",
        width: 12,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Marca",
        key: "brand",
        width: 15,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Modelo",
        key: "model",
        width: 15,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "RENAVAM",
        key: "renavam",
        width: 15,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Status",
        key: "status",
        width: 12,
        formatter: (value) => statusMap[value] || value,
      },

      {
        header: "Tipo de Frota",
        key: "fleet_type",
        width: 15,
        formatter: (value) => fleetTypeMap[value] || value,
      },

      {
        header: "Km Atual",
        key: "current_mileage",
        width: 12,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Km/L",
        key: "km_per_liter",
        width: 8,
        formatter: kmPerLiter,
      },

      {
        header: "Tipo de Veículo",
        key: "vehicleTypeName",
        width: 18,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Tipo de Combustível",
        key: "fuelTypeName",
        width: 18,
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
        header: "Data de Aquisição",
        key: "acquisition_date",
        width: 18,
        formatter: (value) => formatPickedDay(value, timeZone),
      },

      {
        header: "Ano de Fabricação",
        key: "manufacturing_year",
        width: 18,
        formatter: yearOnly,
      },

      {
        header: "Ano do Modelo",
        key: "model_year",
        width: 15,
        formatter: yearOnly,
      },

      {
        header: "Nº de Eixos",
        key: "number_of_axles",
        width: 12,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Intervalo Manutenção (km)",
        key: "maintenance_interval_km",
        width: 22,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Intervalo Manutenção (meses)",
        key: "maintenance_interval_months",
        width: 25,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Última Manutenção",
        key: "last_maintenance_date",
        width: 18,
        formatter: (value) => formatPickedDay(value, timeZone),
      },

      {
        // With the date above, what tells a service overdue by mileage (the
        // table shows both; the file had only the date).
        header: "Km da Última Manutenção",
        key: "last_maintenance_mileage",
        width: 22,
        formatter: ExportFormatters.fallback,
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
        formatter: (value) => formatInstant(value, timeZone),
      },

      {
        header: "Atualizado em",
        key: "updated_at",
        width: 20,
        formatter: (value) => formatInstant(value, timeZone),
      },
    ];

    const filename = `relatorio-veiculos-${businessDateKey(new Date(), timeZone)}`;

    return { iterator, columns, filename };
  }
}

export { ExportVehicleUseCase };
