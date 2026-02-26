import { z } from "zod";

import { createProfileAccessSchema } from "@/schemas/create-profile-access";

import { updateDeleteProfileAccessSchema } from "@/schemas/update-delete-profile-access-schema";
import { updateProfileAccessSchema } from "@/schemas/update-profile-access";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

const profileAccessSchemas = {
  createProfileAccess: createProfileAccessSchema,
  listProfileAccess: listPagesSchema,
  listProfileBusiness: listPagesByBusinessSchema,
  updateDeleteProfileAccess: updateDeleteProfileAccessSchema,
  updateProfileAccess: updateProfileAccessSchema,
};

const profileAccessResponses = {
  profileAccessCreated: z.object({
    message: z.string().default("Perfil de acesso criado com sucesso!"),
  }),

  profileAccessList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        businessId: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
        business: z.object({
          id: z.string(),
          fantasy_name: z.string(),
          corporate_reason: z.string(),
        }),
      }),
    ),
    total: z.number(),
  }),

  profileBusinessList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        businessId: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
      }),
    ),
    total: z.number(),
  }),

  profileAccessUpdated: z.object({
    message: z.string().default("Perfil de acesso atualizado com sucesso!"),
  }),

  profileAccessDeleted: z.object({
    message: z.string().default("Perfil de acesso deletado com sucesso!"),
  }),

  // Common error responses
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

  profileAccessNotFound: z.object({
    message: z.string().default("Perfil de acesso não encontrado!"),
  }),

  businessNotFound: z.object({
    message: z.string().default("Empresa não encontrada!"),
  }),

  profileAccessAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Este perfil não está disponível para cadastro. Já existe um perfil com este nome.",
      ),
  }),

  profileAccessCannotBeUpdatedByHimself: z.object({
    message: z
      .string()
      .default(
        "Usuário não tem permissão para atualizar o seu próprio perfil de acesso.",
      ),
  }),

  profileAccessCannotBeDeletedByHimself: z.object({
    message: z
      .string()
      .default(
        "Usuário não tem permissão para deletar o seu próprio perfil de acesso.",
      ),
  }),

  // Grouping errors by route
  createProfileAccessErrors: z.union([
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
        .default(
          "Este perfil não está disponível para cadastro. Já existe um perfil com este nome.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),

  listProfileAccessErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  listProfileBusinessErrors: z.union([
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

  updateProfileAccessErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Perfil de acesso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este perfil não está disponível para cadastro. Já existe um perfil com este nome.",
        ),
    }),
  ]),

  deleteProfileAccessErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Perfil de acesso não encontrado!"),
    }),
  ]),
};

export { profileAccessSchemas, profileAccessResponses };
