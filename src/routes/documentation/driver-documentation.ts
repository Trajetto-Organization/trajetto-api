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
        birth_date: z.string(),
        driver_license: z.string(),
        cpf: z.string(),
        rg: z.string(),
        cep: z.string(),
        city: z.string(),
        uf: z.string(),
        street: z.string(),
        address_number: z.string(),
        complement: z.string(),
        status: z.string(),
        contract_type: z.string(),
        registration_date: z.string(),
        businessId: z.string(),
        branchId: z.string().nullable(),
        business_name: z.string().nullable(),
        branchName: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
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
      .default("Já existe um motorista cadastrado com este CPF!"),
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
        .default("Já existe um motorista cadastrado com este CPF!"),
    }),
    z.object({
      message: z
        .string()
        .default("Já existe um motorista cadastrado com esta CNH!"),
    }),
    z.object({
      message: z.string().default("Esta filial não pertence a esta empresa!"),
    }),
  ]),

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
        .default("Este motorista não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Esta filial não pertence a esta empresa!"),
    }),
  ]),

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
    z.object({
      message: z
        .string()
        .default("Este motorista não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível excluir este motorista pois ele está associado a veículos.",
        ),
    }),
  ]),
};

export { driverSchemas, driverResponses };
