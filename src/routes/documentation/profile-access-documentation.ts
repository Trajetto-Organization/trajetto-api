import { z } from "zod";

import { createProfileAccessSchema } from "@/schemas/create-profile-access";

import { updateDeleteProfileAccessSchema } from "@/schemas/update-delete-profile-access-schema";
import { updateProfileAccessSchema } from "@/schemas/update-profile-access";

import { listProfileAccessSchema } from "@/schemas/list-profile-access-schema";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { errorResponse } from "./common-responses";

const isoDateTime = z.union([z.string(), z.date()]);
const codedError = z.object({ code: z.string().optional() });

/**
 * A refusal as the error handler sends it: always with a code (decision
 * 11.3). The description lists the codes the route can answer with.
 */
const refusal = (description: string) =>
  errorResponse.extend({ code: z.string() }).describe(description);

const profileAccessSchemas = {
  createProfileAccess: createProfileAccessSchema,
  listProfileAccess: listProfileAccessSchema,
  updateDeleteProfileAccess: updateDeleteProfileAccessSchema,
  updateProfileAccess: updateProfileAccessSchema,
  // The picker's search: the typed term is matched against the name.
  searchProfileCursor: cursorPaginationByBusinessSchema.extend({
    editable: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true")
      .describe(
        "true: só os perfis cujas permissões quem pergunta pode alterar (um usuário comum não recebe o próprio perfil). Usado pelo formulário de permissões.",
      ),
  }),
};

/** A profile as the cursor search streams it: the bare row. */
const profileAccessRow = z.object({
  id: z.string(),
  name: z.string(),
  businessId: z.string(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});

const profileAccessResponses = {
  profileAccessCreated: z.object({
    message: z.string().default("Perfil de acesso criado com sucesso!"),
  }),

  profileAccessRow,

  /** A line of GET /profile-access/list-profile-access. */
  profileAccessListRow: profileAccessRow.extend({
    usersCount: z.number().int().describe("Usuários com este perfil."),
    permissionsCount: z
      .number()
      .int()
      .describe("Permissões configuradas no perfil."),
  }),

  profileAccessUpdated: z.object({
    message: z.string().default("Perfil de acesso atualizado com sucesso!"),
  }),

  profileAccessDeleted: z.object({
    message: z.string().default("Perfil de acesso deletado com sucesso!"),
  }),

  internalServerError: z.object({
    code: z.string().optional(),
    message: z.string().default("Internal server error"),
  }),

  profileAccessCannotBeUpdatedByHimself: refusal(
    "PERMISSION_DENIED (alterar o próprio perfil de acesso) ou TENANT_ACCESS_DENIED (o `businessId` do corpo é de outra empresa). Perfil de outra empresa no caminho responde 404 PROFILE_ACCESS_NOT_FOUND, como um id que não existe.",
  ),

  profileAccessCannotBeDeletedByHimself: refusal(
    "PERMISSION_DENIED (excluir o próprio perfil de acesso). Perfil de outra empresa responde 404 PROFILE_ACCESS_NOT_FOUND, como um id que não existe.",
  ),

  createProfileAccessErrors: refusal("VALIDATION_ERROR (corpo inválido)."),

  lookupNotFound: refusal("USER_NOT_FOUND ou BUSINESS_NOT_FOUND."),

  profileAccessConflict: z
    .object({
      message: z
        .string()
        .default(
          "Este perfil não está disponível para cadastro. Já existe um perfil com este nome.",
        ),
    })
    .and(codedError)
    .describe("PROFILE_ACCESS_ALREADY_EXISTS (nome repetido na empresa)."),

  profileAccessInUse: z
    .object({
      code: z.string().describe("PROFILE_ACCESS_IN_USE."),
      message: z
        .string()
        .default(
          "Este perfil de acesso está em uso por 2 usuários. Troque o perfil deles antes de excluir.",
        ),
      usersCount: z
        .number()
        .int()
        .optional()
        .describe("Usuários ainda ligados ao perfil."),
    })
    .describe(
      "O perfil está em uso: excluir deixaria essas pessoas sem acesso.",
    ),

  listProfileAccessErrors: z
    .object({
      message: z
        .string()
        .default(
          "Empresa não identificada. Selecione uma empresa para continuar.",
        ),
    })
    .and(codedError)
    .describe(
      "Ordenação inválida, ou MASTER sem `businessId` (code BUSINESS_NOT_IDENTIFIED).",
    ),

  listProfileBusinessErrors: refusal(
    "VALIDATION_ERROR (busca, cursor ou empresa inválidos).",
  ),

  updateProfileAccessErrors: refusal(
    "VALIDATION_ERROR (corpo ou id inválido).",
  ),

  deleteProfileAccessErrors: refusal("VALIDATION_ERROR (id inválido)."),

  profileAccessWriteNotFound: refusal(
    "PROFILE_ACCESS_NOT_FOUND, USER_NOT_FOUND ou BUSINESS_NOT_FOUND.",
  ),
};

export { profileAccessSchemas, profileAccessResponses };
