import { inject, injectable } from "tsyringe";
import { AppError } from "@/shared/errors/AppError";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IVehicleChecklistRepository } from "../../repositories/IVehicle-checklist-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { VehicleChecklistNoChecklistsToExportError } from "../errors/vehicle-checklist-no-checklists-to-export-error";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";
import { formatInstant, formatPickedDay } from "@/shared/vehicle/record-dates";
import type { ChecklistCondition } from "../list-vehicle-checklist/checklist-list";

interface ExportVehicleChecklistRequest {
  userId: string;
  /** The MASTER names the company; everyone else exports their own. */
  businessId?: string;
  search?: string;
  conditions?: ChecklistCondition[];
  branchIds?: string[];
  vehicleIds?: string[];
}

/**
 * The checklist table as a file, with the SAME search and filters as the
 * screen (decision 5.8) and for the company on screen: the MASTER's export
 * used to put every company's inspections in one sheet.
 */
@injectable()
class ExportVehicleChecklistExcelUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  /**
   * Prepare iterator (AsyncGenerator) + columns + filename
   */
  async execute({
    userId,
    businessId,
    search,
    conditions,
    branchIds,
    vehicleIds,
  }: ExportVehicleChecklistRequest) {
    const findUser = await this.user.findUserById(userId);
    if (!findUser) throw new ResourceNotFoundError();

    // Drivers hold fuel and checklist WRITE so the app can submit their own
    // records. An export is the back office reading the whole company —
    // every driver, CNH, value and position — which that grant never meant.
    if (findUser.driverId) {
      throw new AppError(
        "Motoristas não exportam dados da frota.",
        403,
        "DRIVER_CANNOT_EXPORT",
      );
    }

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
      conditions,
      branchIds,
      vehicleIds,
    };

    const total = await this.vehicleChecklist.countChecklistForExport(filters);

    if (total === 0) {
      throw new VehicleChecklistNoChecklistsToExportError();
    }

    const iterator = this.vehicleChecklist.streamChecklistsForExport(filters);

    // The company's day, not the server's: at 22:00 in São Paulo the UTC
    // date is already tomorrow — in the file name and in every date column.
    const timeZone = resolveTimeZone(
      (findBusiness as { timezone?: string | null }).timezone,
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
        header: "Quilometragem do Veículo",
        key: "vehicleCurrentMileage",
        width: 20,
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
        header: "Data da Vistoria",
        key: "checklist_date",
        width: 18,
        formatter: (value) => formatPickedDay(value, timeZone),
      },

      {
        header: "Quilometragem no Checklist",
        key: "current_mileage",
        width: 20,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "Condição dos Pneus",
        key: "tires_condition",
        width: 18,
        formatter: ExportFormatters.formatCondition,
      },

      {
        header: "Faróis",
        key: "headlights_working",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Lanternas",
        key: "taillights_working",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Setas",
        key: "turn_signals_working",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Para-choques",
        key: "bumpers_condition",
        width: 15,
        formatter: ExportFormatters.formatCondition,
      },

      {
        header: "Para-brisa",
        key: "windshield_condition",
        width: 15,
        formatter: ExportFormatters.formatCondition,
      },

      {
        header: "Retrovisores",
        key: "mirrors_condition",
        width: 15,
        formatter: ExportFormatters.formatCondition,
      },

      {
        header: "Cintos de Segurança",
        key: "seatbelts_working",
        width: 18,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Painel",
        key: "dashboard_working",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Volante",
        key: "steering_wheel_condition",
        width: 15,
        formatter: ExportFormatters.formatCondition,
      },

      {
        header: "Freios",
        key: "brakes_working",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Embreagem",
        key: "clutch_working",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Nível de Combustível",
        key: "fuel_level_adequate",
        width: 20,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Nível de Óleo",
        key: "oil_level_adequate",
        width: 15,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Água do Radiador",
        key: "radiator_water_adequate",
        width: 18,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Fluido de Freio",
        key: "brake_fluid_adequate",
        width: 15,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Bateria",
        key: "battery_condition",
        width: 12,
        formatter: ExportFormatters.formatCondition,
      },

      {
        header: "CNH Válida",
        key: "driver_license_valid",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Documentos do Veículo",
        key: "vehicle_documents_valid",
        width: 20,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Seguro",
        key: "insurance_valid",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Extintor",
        key: "fire_extinguisher_valid",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Triângulo",
        key: "warning_triangle_present",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Macaco",
        key: "jack_present",
        width: 12,
        formatter: ExportFormatters.vehicleChecklistFallback,
      },

      {
        header: "Estepe",
        key: "spare_tire_condition",
        width: 15,
        formatter: ExportFormatters.formatCondition,
      },

      {
        header: "Condição Geral",
        key: "overall_condition",
        width: 15,
        formatter: ExportFormatters.formatCondition,
      },

      {
        header: "Observações",
        key: "notes",
        width: 30,
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

    const filename = `relatorio-checklists-veiculares-${businessDateKey(new Date(), timeZone)}`;

    return { iterator, columns, filename };
  }
}

export { ExportVehicleChecklistExcelUseCase };
