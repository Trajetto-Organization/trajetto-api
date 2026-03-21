import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IVehicleChecklistRepository } from "../../repositories/IVehicle-checklist-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

@injectable()
class ExportVehicleChecklistExcelUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
  ) {}

  /**
   * Prepare iterator (AsyncGenerator) + columns + filename
   */
  async execute(userId: string, search?: string) {
    const findUser = await this.user.findUserById(userId);
    if (!findUser) throw new ResourceNotFoundError();

    const iterator = this.vehicleChecklist.streamChecklistsForExport(
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
        formatter: ExportFormatters.date,
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

    const filename = `relatorio-checklists-veiculares-${
      new Date().toISOString().split("T")[0]
    }`;

    return { iterator, columns, filename };
  }
}

export { ExportVehicleChecklistExcelUseCase };
