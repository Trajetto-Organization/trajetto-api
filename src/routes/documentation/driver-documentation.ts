import { z } from "zod";
import { createDriverSchema } from "@/schemas/create-driver-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDriverSchema } from "@/schemas/update-driver-schema";

import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

const driverBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  driverId: z.string().uuid("O ID do motorista é obrigatório!"),
});

const driverSchemas = {
  createDriver: createDriverSchema,
  listDriver: listPagesSchema,
  listDriverBusiness: listPagesByBusinessSchema,
  updateDriver: updateDriverSchema,
  businessIdParam: updateDeleteBusinessSchema,
  driverBusinessParams: driverBusinessParams,
};

const driverResponses = {
  driverCreated: z.object({
    message: z.string().default("Motorista criado com sucesso!"),
  }),
  driverList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        birth_date: z.union([z.string(), z.date()]),
        cnh: z.string(),
        cpf: z.string(),
        rg: z.string(),
        cep: z.string(),
        city: z.string(),
        uf: z.string(),
        street: z.string(),
        address_number: z.string(),
        complement: z.string().nullable(),
        status: z.string(),
        contract_type: z.string(),
        businessId: z.string(),
        branchId: z.string().nullable(),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .optional(), // Only for MASTER role
        branch: z
          .object({
            corporate_reason: z.string(),
          })
          .nullable()
          .optional(),
      }),
    ),
    total: z.number(),
  }),
  driverUpdated: z.object({
    message: z.string().default("Motorista atualizado com sucesso!"),
  }),

  driverDeleted: z.object({
    message: z.string().default("Motorista deletado com sucesso!"),
  }),

  // Common Error Responses
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
  validationError: z.object({
    message: z.string().default("Validation Error"),
    issues: z.array(z.string()),
  }),
  driverNotFound: z.object({
    message: z.string().default("Motorista não encontrado!"),
  }),
  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),
  branchNotFound: z.object({
    message: z.string().default("Filial não encontrada!"),
  }),
  driverCpfAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Este CPF não está disponível para cadastro. Os CPFs de motoristas devem ser únicos em todo o sistema.",
      ),
  }),
  driverLicenseAlreadyExists: z.object({
    message: z
      .string()
      .default("Já existe um motorista cadastrado com esta CNH!"),
  }),
  driverInUse: z.object({
    message: z
      .string()
      .default(
        "Não é possível excluir este motorista pois ele está associado a veículos.",
      ),
  }),
  driverCannotListDrivers: z.object({
    message: z
      .string()
      .default(
        "Motoristas não possuem permissão para visualizar a lista de motoristas.",
      ),
  }),
  driverRgAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Este RG não está disponível para cadastro. Os RGs de motoristas devem ser únicos em todo o sistema.",
      ),
  }),
  branchNotBelongBusiness: z.object({
    message: z.string().default("Esta filial não pertence a esta empresa!"),
  }),
  driverNotBelongBusiness: z.object({
    message: z.string().default("Este motorista não pertence a esta empresa!"),
  }),
  driverHasAssociatedFines: z.object({
    message: z
      .string()
      .default(
        "Não é possível deletar este motorista pois existem multa(s) associada(s).",
      ),
  }),
  driverHasAssociatedChecklists: z.object({
    message: z
      .string()
      .default(
        "Não é possível deletar este motorista pois existem checklist(s) associado(s).",
      ),
  }),
  driverHasAssociatedFuel: z.object({
    message: z
      .string()
      .default(
        "Não é possível deletar este motorista pois existem registro(s) de abastecimento associado(s).",
      ),
  }),
  driverHasAssociatedUser: z.object({
    message: z
      .string()
      .default(
        "Este motorista possui um usuário vinculado. Desvincule o usuário antes de excluir o motorista.",
      ),
  }),

  // Grouping errors by route
  createDriverErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Filial não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este CPF não está disponível para cadastro. Os CPFs de motoristas devem ser únicos em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este RG não está disponível para cadastro. Os RGs de motoristas devem ser únicos em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Já existe um motorista cadastrado com esta CNH!"),
    }),
  ]),
  createDriverForbiddenErrors: z.object({
    message: z.string().default("Esta filial não pertence a esta empresa!"),
  }),
  listDriverErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),
  listDriverBusinessErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),
  updateDriverErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Filial não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este CPF não está disponível para cadastro. Os CPFs de motoristas devem ser únicos em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este RG não está disponível para cadastro. Os RGs de motoristas devem ser únicos em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Já existe um motorista cadastrado com esta CNH!"),
    }),
  ]),
  updateDriverForbiddenErrors: z.object({
    message: z.string().default("Esta filial não pertence a esta empresa!"),
  }),
  deleteDriverErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado!"),
    }),
    z.object({
      message: z.string().default("Empresa não encontrada!"),
    }),
  ]),
  deleteDriverForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default("Este motorista não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível deletar este motorista pois existem multa(s) associada(s).",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível deletar este motorista pois existem checklist(s) associado(s).",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível deletar este motorista pois existem registro(s) de abastecimento associado(s).",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este motorista possui um usuário vinculado. Desvincule o usuário antes de excluir o motorista.",
        ),
    }),
  ]),
};

export { driverSchemas, driverResponses };
