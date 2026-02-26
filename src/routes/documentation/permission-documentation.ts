import { z } from "zod";

import { createPermissionSchema } from "@/schemas/create-permission-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { updatePermissionSchema } from "@/schemas/update-permission-schema";
import { updateDeletePermissionSchema } from "@/schemas/update-delete-permission-schema";

const permissionSchemas = {
  createPermission: createPermissionSchema,
  listPermission: listPagesSchema,
  updatePermission: updatePermissionSchema,
  updateDeletePermission: updateDeletePermissionSchema,
};

const permissionResponses = {
  permissionCreated: z.object({
    message: z.string().default("Permissão criada com sucesso!"),
  }),

  permissionList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        action: z.string(),
        canRead: z.boolean(),
        canWrite: z.boolean(),
        created_at: z.string(),
        updated_at: z.string(),
        permission_key: z.string(),
        business_id: z.string(),
        profile_access_id: z.string(),
        business: z.object({
          id: z.string(),
          fantasy_name: z.string(),
        }),
        profile_access: z.object({
          id: z.string(),
          name: z.string(),
        }),
      }),
    ),
    total: z.number(),
    currentPage: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
  }),

  permissionUpdated: z.object({
    message: z.string().default("Permissão atualizada com sucesso!"),
  }),

  permissionDeleted: z.object({
    message: z.string().default("Permissão deletada com sucesso!"),
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

  permissionNotFound: z.object({
    message: z.string().default("Permissão não encontrada!"),
  }),

  businessNotFound: z.object({
    message: z.string().default("Empresa não encontrada!"),
  }),

  profileAccessNotFound: z.object({
    message: z.string().default("Perfil de acesso não encontrado!"),
  }),

  permissionAlreadyExists: z.object({
    message: z.string().default("Esta permissão já existe!"),
  }),

  permissionAlreadyAssigned: z.object({
    message: z.string().default("Esta permissão já está atribuída!"),
  }),

  permissionBusinessError: z.object({
    message: z.string().default("Erro na permissão da empresa!"),
  }),

  permissionCannotBeUpdatedByHimself: z.object({
    message: z
      .string()
      .default(
        "Usuário não tem permissão para atualizar a sua própria permissão",
      ),
  }),

  permissionCannotBeDeletedByHimself: z.object({
    message: z
      .string()
      .default(
        "Usuário não tem permissão para deletar a sua própria permissão",
      ),
  }),

  // Grouping errors by route
  createPermissionErrors: z.union([
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
        .default("O perfil de acesso não pertence a essa empresa."),
    }),
    z.object({
      message: z
        .string()
        .default("Esta permissão já está atribuída com este perfil."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Já existe uma permissão com esse nome para este perfil! Para alterar, remova a permissão existente primeiro.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default("Perfil de acesso não encontrado! Por favor tente novamente."),
    }),
  ]),

  listPermissionErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  updatePermissionErrors: z.union([
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
        .default("O perfil de acesso não pertence a essa empresa."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Já existe uma permissão com esse nome para este perfil! Para alterar, remova a permissão existente primeiro.",
        ),
    }),
    z.object({
      message: z.string().default("Permissão não encontrada!"),
    }),
    z.object({
      message: z.string().default("Perfil de acesso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default("Esta permissão já está atribuída com este perfil."),
    }),
  ]),

  updatePermissionForbiddenErrors: z.object({
    message: z
      .string()
      .default(
        "Usuário não tem permissão para atualizar a sua própria permissão",
      ),
  }),

  deletePermissionErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Permissão não encontrada!"),
    }),
  ]),
};

export { permissionSchemas, permissionResponses };
