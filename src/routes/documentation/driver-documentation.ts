import { z } from "zod";
import { createDriverSchema } from "@/schemas/create-driver-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDriverSchema } from "@/schemas/update-driver-schema";

import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";
import {
  exportDriverSchema,
  listDriverSchema,
} from "@/schemas/list-driver-schema";

import { searchMetaDoc } from "@/shared/pagination/list-meta";
import { CNH_CATEGORIES } from "@/modules/driver/usecases/list-driver/driver-list";

import { errorResponse, internalErrorResponse } from "./common-responses";

const driverBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  driverId: z.string().uuid("O ID do motorista é obrigatório!"),
});

const driverSchemas = {
  createDriver: createDriverSchema,
  listDriver: listDriverSchema,
  updateDriver: updateDriverSchema,
  businessIdParam: updateDeleteBusinessSchema,
  driverBusinessParams: driverBusinessParams,
  exportDriverQuery: exportDriverSchema,
  searchDriverCursor: cursorPaginationByBusinessSchema,
};

const isoDate = z.union([z.string(), z.date()]);

const cnhFields = {
  cnh_category: z
    .enum(CNH_CATEGORIES)
    .nullable()
    .describe("Categoria da CNH; null quando não informada."),
  cnh_expires_at: isoDate
    .nullable()
    .describe(
      "Validade da CNH: data civil, sempre AAAA-MM-DDT00:00:00.000Z (leia o dia UTC); null quando não informada.",
    ),
};

/** One line of GET /driver/list-driver. */
const driverListItem = z.object({
  id: z.string(),
  name: z.string(),
  birth_date: isoDate.describe(
    "Data de nascimento: data civil, AAAA-MM-DDT00:00:00.000Z (leia o dia UTC). Registros antigos guardam a meia-noite local, que é o mesmo dia UTC no Brasil.",
  ),
  cnh: z.string(),
  cpf: z.string(),
  ...cnhFields,
  cnh_status: z
    .enum(["EXPIRED", "EXPIRING", "VALID"])
    .nullable()
    .describe(
      "Situação da CNH no dia de negócio da empresa: EXPIRED vencida, EXPIRING vence em até 30 dias, VALID em dia; null sem validade informada.",
    ),
  rg: z.string(),
  cep: z.string(),
  city: z.string(),
  uf: z.string(),
  street: z.string(),
  address_number: z.string(),
  complement: z.string().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  contract_type: z.enum(["OWNED", "THIRD_PARTY"]),
  businessId: z.string(),
  branchId: z.string().nullable(),
  branch: z.object({ corporate_reason: z.string() }).nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});

/** The list's `meta.searchMeta`, as summarizeDriverList builds it. */
const driverListSearchMeta = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe(
        "Motoristas da busca e dos demais filtros, sem o de situação (Ativos + Inativos).",
      ),
    active: z.number().int().describe("Dos quais ativos."),
    inactive: z.number().int().describe("Dos quais inativos."),
    owned: z
      .number()
      .int()
      .describe("Próprios, com todos os filtros menos o de tipo de contrato."),
    thirdParty: z
      .number()
      .int()
      .describe(
        "Terceirizados, com todos os filtros menos o de tipo de contrato.",
      ),
  },
  ["status", "contract_type", "cnh_category", "branchId"],
);

/**
 * One line of the picker. `cnh`, `branchId`, `businessId` and `created_at`
 * come only for the driver catalogue (`driver_manage:read`); a dispatcher who
 * reaches the picker through `delivery_manage:write` gets the rest.
 */
const driverPickerItem = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  ...cnhFields,
  cnh: z
    .string()
    .optional()
    .describe("Só para quem lê o cadastro de motoristas."),
  branchId: z.string().nullable().optional(),
  businessId: z.string().optional(),
  created_at: isoDate.optional(),
});

const message = (text: string) =>
  z.object({ message: z.string().default(text) });

const driverResponses = {
  driverCreated: message("Motorista criado com sucesso!"),
  driverUpdated: message("Motorista atualizado com sucesso!"),
  driverDeleted: message("Motorista deletado com sucesso!"),

  driverListItem,
  driverListSearchMeta,
  driverPickerItem,

  /**
   * Every refusal leaves in the shared error shape, with its `code`:
   * VALIDATION_ERROR (400, with `issues`), BUSINESS_NOT_IDENTIFIED (400),
   * PERMISSION_DENIED / TENANT_ACCESS_DENIED (403), DRIVER_NOT_FOUND,
   * BRANCH_NOT_FOUND, BUSINESS_NOT_FOUND (404) and the conflicts below (409).
   */
  error: errorResponse,

  validationErrors: errorResponse.describe(
    "VALIDATION_ERROR (campos recusados em `issues`), BUSINESS_NOT_IDENTIFIED (MASTER sem `businessId`), ordenação ou filtro inválidos.",
  ),
  forbidden: errorResponse.describe(
    "PERMISSION_DENIED (perfil sem a permissão) ou TENANT_ACCESS_DENIED (empresa de outro usuário).",
  ),
  writeForbidden: errorResponse.describe(
    "PERMISSION_DENIED (perfil sem a permissão de escrita), TENANT_ACCESS_DENIED (empresa de outro usuário) ou TENANT_INACTIVE (empresa desativada: cadastro só de leitura, inclusive para o MASTER).",
  ),
  notFound: errorResponse.describe(
    "DRIVER_NOT_FOUND, BRANCH_NOT_FOUND, BUSINESS_NOT_FOUND ou TENANT_NOT_FOUND (empresa do caminho inexistente). O motorista ou a filial de outra empresa respondem igual a um inexistente.",
  ),
  writeConflicts: errorResponse.describe(
    "DRIVER_CPF_ALREADY_EXISTS ou DRIVER_CNH_ALREADY_EXISTS: o CPF ou a CNH já é de outro motorista DESTA empresa (são únicos por empresa; a mensagem nunca fala de outra). Na edição, também DRIVER_HAS_OPEN_ROUTES: inativar um motorista com rota planejada, liberada ou em andamento é recusado, com a contagem na mensagem.",
  ),
  deleteConflicts: errorResponse.describe(
    "O motorista tem histórico: DRIVER_HAS_USER, DRIVER_HAS_FINES, DRIVER_HAS_FUELS, DRIVER_HAS_CHECKLISTS, DRIVER_HAS_OPERATION (entregas ou rotas) ou DRIVER_HAS_PAUSES. Inative-o em vez de excluir.",
  ),
  exportErrors: errorResponse.describe(
    "NOTHING_TO_EXPORT (nenhum motorista na busca e nos filtros), BUSINESS_NOT_IDENTIFIED (MASTER sem `businessId`) ou VALIDATION_ERROR.",
  ),

  internalServerError: internalErrorResponse,
};

export { driverSchemas, driverResponses };
