import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IVehicleRepository } from "../../repositories/IVehicle-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

@injectable()
class ExportVehicleUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
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

    const iterator = this.vehicle.streamVehiclesForExport(
      findUser.businessId!,
      findUser.role,
      search,
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
        formatter: ExportFormatters.number3,
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
        formatter: ExportFormatters.date,
      },

      {
        header: "Ano de Fabricação",
        key: "manufacturing_year",
        width: 18,
        formatter: ExportFormatters.date,
      },

      {
        header: "Ano do Modelo",
        key: "model_year",
        width: 15,
        formatter: ExportFormatters.date,
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
        formatter: (value) => (value ? ExportFormatters.date(value) : "N/A"),
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

    const filename = `relatorio-veiculos-${
      new Date().toISOString().split("T")[0]
    }`;

    return { iterator, columns, filename };
  }
}

export { ExportVehicleUseCase };
