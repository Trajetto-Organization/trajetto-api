import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "../../repositories/IDriver-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { DriverNoDriversToExportError } from "../errors/driver-no-drivers-to-export-error";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

@injectable()
class ExportDriverUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
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

    const total = await this.driver.countDriversForExport(
      findUser.businessId as string,
      findUser.role,
    );

    if (total === 0) {
      throw new DriverNoDriversToExportError();
    }

    const iterator = this.driver.streamDriversForExport(
      findUser.businessId!,
      findUser.role,
      search,
    );

    const statusMap: Record<string, string> = {
      ACTIVE: "Ativo",
      INACTIVE: "Inativo",
    };

    const contractTypeMap: Record<string, string> = {
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
        header: "Nome",
        key: "name",
        width: 30,
        formatter: ExportFormatters.fallback,
      },

      {
        header: "CPF",
        key: "cpf",
        width: 18,
        formatter: ExportFormatters.cpf,
      },

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
        header: "Data de Nascimento",
        key: "birth_date",
        width: 18,
        formatter: ExportFormatters.date,
      },

      {
        header: "Status",
        key: "status",
        width: 12,
        formatter: (value) => statusMap[value] || value,
      },

      {
        header: "Tipo de Contrato",
        key: "contract_type",
        width: 18,
        formatter: (value) => contractTypeMap[value] || value,
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

    const filename = `relatorio-motoristas-${
      new Date().toISOString().split("T")[0]
    }`;

    return { iterator, columns, filename };
  }
}

export { ExportDriverUseCase };
