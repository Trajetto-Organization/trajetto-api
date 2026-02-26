import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IVehicleChecklistRepository } from "../../repositories/IVehicle-checklist-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  ExcelExportService,
  ExcelColumn,
} from "@/shared/services/excel-export-service";

@injectable()
class ExportVehicleChecklistExcelUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
  ) {}

  async execute(userId: string, search?: string) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Get all vehicle checklists for export using dedicated method
    const checklists =
      await this.vehicleChecklist.getAllVehicleChecklistsForExport(
        findUser.businessId as string,
        findUser.role,
        search,
      );

    // Define columns configuration for vehicle checklists
    const columns: ExcelColumn[] = [
      { header: "ID", key: "id", width: 10 },
      { header: "Placa do Veículo", key: "vehicleLicensePlate", width: 15 },
      {
        header: "Descrição do Veículo",
        key: "vehicleDescription",
        width: 25,
      },
      { header: "Marca", key: "vehicleBrand", width: 15 },
      { header: "Modelo", key: "vehicleModel", width: 15 },
      {
        header: "Quilometragem do Veículo",
        key: "vehicleCurrentMileage",
        width: 20,
      },
      { header: "Motorista", key: "driverName", width: 25 },
      {
        header: "CNH do Motorista",
        key: "driverCnh",
        width: 18,
      },
      {
        header: "Data da Vistoria",
        key: "checklist_date",
        width: 18,
        formatter: ExcelExportService.formatters.date,
      },
      {
        header: "Quilometragem no Checklist",
        key: "current_mileage",
        width: 20,
      },
      { header: "Condição dos Pneus", key: "tires_condition", width: 18 },
      { header: "Faróis", key: "headlights_working", width: 12 },
      { header: "Lanternas", key: "taillights_working", width: 12 },
      { header: "Setas", key: "turn_signals_working", width: 12 },
      { header: "Para-choques", key: "bumpers_condition", width: 15 },
      { header: "Para-brisa", key: "windshield_condition", width: 15 },
      { header: "Retrovisores", key: "mirrors_condition", width: 15 },
      {
        header: "Cintos de Segurança",
        key: "seatbelts_working",
        width: 18,
      },
      { header: "Painel", key: "dashboard_working", width: 12 },
      { header: "Volante", key: "steering_wheel_condition", width: 15 },
      { header: "Freios", key: "brakes_working", width: 12 },
      { header: "Embreagem", key: "clutch_working", width: 12 },
      {
        header: "Nível de Combustível",
        key: "fuel_level_adequate",
        width: 20,
      },
      { header: "Nível de Óleo", key: "oil_level_adequate", width: 15 },
      {
        header: "Água do Radiador",
        key: "radiator_water_adequate",
        width: 18,
      },
      { header: "Fluido de Freio", key: "brake_fluid_adequate", width: 15 },
      { header: "Bateria", key: "battery_condition", width: 12 },
      { header: "CNH Válida", key: "driver_license_valid", width: 12 },
      {
        header: "Documentos do Veículo",
        key: "vehicle_documents_valid",
        width: 20,
      },
      { header: "Seguro", key: "insurance_valid", width: 12 },
      { header: "Extintor", key: "fire_extinguisher_valid", width: 12 },
      {
        header: "Triângulo",
        key: "warning_triangle_present",
        width: 12,
      },
      { header: "Macaco", key: "jack_present", width: 12 },
      { header: "Estepe", key: "spare_tire_condition", width: 15 },
      {
        header: "Condição Geral",
        key: "overall_condition",
        width: 15,
      },
      { header: "Observações", key: "notes", width: 30 },
      { header: "Filial", key: "branchName", width: 20 },
      ...(findUser.role === "MASTER"
        ? [{ header: "Empresa", key: "businessName", width: 25 }]
        : []),
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
      data: checklists,
      columns,
      sheetName: "Relatório de Checklists Veiculares",
      filename: `relatorio-checklists-veiculares-${new Date().toISOString().split("T")[0]}`,
    });
  }
}

export { ExportVehicleChecklistExcelUseCase };
