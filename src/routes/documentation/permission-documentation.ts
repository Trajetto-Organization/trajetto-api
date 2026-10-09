import { z } from "zod";

import { createPermissionSchema } from "@/schemas/create-permission-schema";
import { listPermissionSchema } from "@/schemas/list-permission-schema";
import { searchMetaDoc } from "@/shared/pagination/list-meta";

import { updatePermissionSchema } from "@/schemas/update-permission-schema";
import { updateDeletePermissionSchema } from "@/schemas/update-delete-permission-schema";

import { bulkConfigurePermissionsSchema } from "@/schemas/bulk-configure-permissions-schema";
import { updateDeleteProfileAccessSchema } from "@/schemas/update-delete-profile-access-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { errorResponse } from "./common-responses";

/**
 * A refusal as the error handler sends it: always with a code (decision
 * 11.3). The description lists the codes the route can answer with.
 */
const refusal = (description: string) =>
  errorResponse.extend({ code: z.string() }).describe(description);

const permissionSchemas = {
  createPermission: createPermissionSchema,
  listPermission: listPermissionSchema,
  updatePermission: updatePermissionSchema,
  updateDeletePermission: updateDeletePermissionSchema,
  bulkConfigurePermissions: bulkConfigurePermissionsSchema,
  listByProfile: updateDeleteProfileAccessSchema,
  listByProfileQuery: updateDeleteBusinessSchema,
};

const permissionResponses = {
  permissionCreated: z.object({
    message: z.string().default("Permissão criada com sucesso!"),
  }),

  /** A line of GET /permission/list-permission. */
  permissionListRow: z.object({
    id: z.string(),
    action: z.string(),
    permissionKey: z.string(),
    canRead: z.boolean(),
    canWrite: z.boolean(),
    businessId: z.string(),
    profileAccessId: z.string(),
    created_at: z.union([z.string(), z.date()]),
    updated_at: z.union([z.string(), z.date()]),
    profileAccess: z.object({ name: z.string() }),
  }),

  /** Cards and filter options of the list, counted over the whole company. */
  permissionListSearchMeta: searchMetaDoc(
    {
      total: z
        .number()
        .int()
        .describe("Permissões na busca e nos filtros, exceto o de escrita."),
      writable: z.number().int().describe("Com escrita."),
      readOnly: z.number().int().describe("Só leitura."),
    },
    ["permissionKey", "profileAccessId", "read", "write"],
  ),

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

  resourceNotFound: refusal("USER_NOT_FOUND: o usuário da sessão não existe mais."),
  validationError: refusal("VALIDATION_ERROR: parâmetro, consulta ou corpo recusado (issues diz qual)."),
  businessNotFound: refusal("USER_NOT_FOUND (o usuário da sessão não existe mais) ou BUSINESS_NOT_FOUND."),
  // Refusals shared by the write routes.
  permissionWriteNotFound: refusal(
    "USER_NOT_FOUND (o usuário da sessão não existe mais), BUSINESS_NOT_FOUND ou PERMISSION_NOT_FOUND (a permissão do caminho não existe ou é de outra empresa).",
  ),
  permissionWriteForbidden: refusal(
    "PERMISSION_DENIED (um usuário comum mexendo nas permissões do próprio perfil — nem criar, nem mover para ele, nem configurar em lote, nem alterar ou excluir as que já estão nele) ou TENANT_ACCESS_DENIED.",
  ),

  permissionWriteConflict: refusal(
    "PERMISSION_ALREADY_EXISTS (mesmo nome no perfil) ou PERMISSION_ALREADY_ASSIGNED (mesmo recurso no perfil).",
  ),

  // Grouping errors by route
  createPermissionErrors: refusal(
    "VALIDATION_ERROR (corpo inválido) ou PROFILE_ACCESS_NOT_FOUND (o perfil indicado no corpo não existe ou é de outra empresa — a mesma resposta).",
  ),
  listPermissionErrors: refusal(
    "VALIDATION_ERROR (parâmetros inválidos) ou BUSINESS_NOT_IDENTIFIED (o MASTER não informou a empresa).",
  ),
  updatePermissionErrors: refusal(
    "VALIDATION_ERROR (corpo ou id inválido) ou PROFILE_ACCESS_NOT_FOUND (o perfil indicado no corpo não existe ou é de outra empresa — a mesma resposta).",
  ),
  deletePermissionErrors: refusal("VALIDATION_ERROR (id inválido)."),

  permissionsConfigured: z.object({
    message: z.string().default("Permissões configuradas com sucesso!"),
  }),

  permissionsByProfile: z.object({
    permissions: z.array(
      z.object({
        id: z.string(),
        action: z.string(),
        permissionKey: z.string(),
        canRead: z.boolean(),
        canWrite: z.boolean(),
        businessId: z.string(),
        profileAccessId: z.string(),
        created_at: z.date(),
        updated_at: z.date(),
      }),
    ),
  }),

  bulkConfigurePermissionsErrors: refusal(
    "VALIDATION_ERROR (linha sem leitura, recurso repetido ou corpo inválido) ou PROFILE_ACCESS_NOT_FOUND (o perfil indicado no corpo não existe ou é de outra empresa — a mesma resposta).",
  ),
};

export { permissionSchemas, permissionResponses };
