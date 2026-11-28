import { z } from "zod";
import { responseDateTime } from "./response-date";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import { errorResponse, internalErrorResponse } from "./common-responses";

import { createBusinessSchema } from "@/schemas/create-business-schema";
import { listBusinessSchema } from "@/schemas/list-business-schema";
import { searchMetaDoc } from "@/shared/pagination/list-meta";

import { updateBusinessSchema } from "@/schemas/update-business-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateAILimitSchema } from "@/schemas/update-ai-limit-schema";
import { updateVehicleLimitSchema } from "@/schemas/update-vehicle-limit-schema";

import { confirmDeletionCodeSchema } from "@/schemas/confirm-deletion-code-schema";
import { scheduleBusinessPurgeSchema } from "@/schemas/schedule-business-purge-schema";
import {
  businessSettingsValuesSchema,
  updateBusinessSettingsSchema,
} from "@/schemas/business-settings-schema";

// What 0 means differs per limit, on purpose (plan M2, LIMIT_ZERO_MEANING in
// shared/entitlements/entitlement-rules): every field that carries one says it.
const AI_LIMIT_DESCRIPTION =
  "Fotos que a IA pode ler por mês, no fuso da empresa (0 = IA desligada: nenhuma foto é lida).";

const VEHICLE_LIMIT_DESCRIPTION =
  "Nº de veículos contratados, base da cobrança (0 = sem limite: não configurado, nunca bloqueia).";

const businessSchemas = {
  createBusiness: createBusinessSchema,
  listBusiness: listBusinessSchema,
  searchBusinessCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de empresas a retornar (padrão: 10)"),
    cursor: z
      .string()
      .optional()
      .describe("ID da última empresa da página anterior para paginação"),
    search: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe("Texto livre, até 100 caracteres."),
  }),
  updateDeleteBusiness: updateDeleteBusinessSchema,
  // Wire format only: the controller re-parses and owns the real validation.
  moduleImpactParams: z.object({
    businessId: z.string().describe("ID da empresa"),
    module: z.string().describe("FLEET ou DELIVERIES"),
  }),
  updateBusiness: updateBusinessSchema,
  updateAILimit: updateAILimitSchema,
  updateVehicleLimit: updateVehicleLimitSchema,
  updateEntitlement: z.object({
    ...tenantLockedShape,
    module: z.enum(["FLEET", "DELIVERIES"]).describe("Módulo vendável."),
    enabled: z.boolean().describe("Habilitar (true) ou desabilitar (false)."),
  }),
  confirmDeletionCode: confirmDeletionCodeSchema,
  scheduleBusinessPurge: scheduleBusinessPurgeSchema,
  // Plan of 02/11/2026 (M1).
  updateBusinessSettings: updateBusinessSettingsSchema,
};

/** GET/PUT /business/:businessId/settings (plan of 02/11/2026, M1). */
const businessSettingsView = businessSettingsValuesSchema.extend({
  businessId: z.string(),
  available: z
    .object({
      checklist: z
        .boolean()
        .describe("O checklist na rota vale: a empresa tem Frota e Entregas."),
      geofence: z
        .boolean()
        .describe("A geocerca vale: a empresa tem Entregas."),
    })
    .describe(
      "Quais seções valem, pelos módulos ligados (M6). Uma configuração cujo módulo está desligado fica guardada e é ignorada pelo app e pela API.",
    ),
  limits: z
    .object({
      geofence_radius_min_m: z.number().int(),
      geofence_radius_max_m: z.number().int(),
    })
    .describe("Os limites do raio, para o formulário."),
  updated_at: responseDateTime()
    .nullable()
    .describe(
      "Quando foram salvas pela última vez; nulo enquanto a empresa usa o padrão.",
    ),
  updated_by: z
    .object({ id: z.string(), name: z.string() })
    .nullable()
    .describe(
      "Quem salvou por último; nulo sem alteração ou se a conta foi excluída.",
    ),
});

/**
 * The scheduled purge of a company (plano-escala F3-25), on every line of
 * the MASTER's list: what the screen says and when the Reativar button
 * shows.
 */
const purgeFields = {
  purge_state: z
    .enum(["SCHEDULED", "PURGING", "PURGED"])
    .nullable()
    .describe(
      "Exclusão agendada: nulo quando nunca foi agendada (uma empresa só desativada fica nula); SCHEDULED enquanto espera (a empresa está inativa e pode ser reativada); PURGING quando os dados começaram a ser apagados (sem volta); PURGED quando terminou.",
    ),
  deactivated_at: responseDateTime()
    .nullable()
    .describe("Quando a exclusão foi agendada e a empresa, desativada."),
  purge_after: responseDateTime()
    .nullable()
    .describe("A partir de quando os dados da empresa são apagados."),
};

/** An error body with the `code` a client branches on (decision 11.3). */
const codedError = (description: string) =>
  z
    .object({
      code: z.string().optional(),
      message: z.string(),
      issues: z.array(z.string()).optional(),
    })
    .describe(description);

const businessResponses = {
  businessConflict: codedError(
    "BUSINESS_CNPJ_TAKEN, BUSINESS_NAME_TAKEN, BUSINESS_EMAIL_TAKEN ou BUSINESS_ERP_CODE_TAKEN: outra empresa já usa o dado. BRANCH_CNPJ_UNAVAILABLE: o CNPJ já é de uma filial. BRANCH_NAME_TAKEN, BRANCH_EMAIL_TAKEN ou BRANCH_ERP_CODE_TAKEN: outra filial DESTA empresa já usa o dado que a matriz receberia.",
  ),
  businessNotFoundCoded: codedError(
    "BUSINESS_NOT_FOUND: a empresa não existe.",
  ),

  businessCreated: z.object({
    message: z.string().default("Empresa e filial matriz criadas com sucesso!"),
  }),
  /** One company line of the list. */
  businessRow: z.object({
    id: z.string(),
    corporate_reason: z.string(),
    fantasy_name: z.string().nullable(),
    cep: z.string(),
    city: z.string(),
    uf: z.string(),
    street: z.string(),
    address_number: z.string(),
    complement: z.string().nullable(),
    cnae: z.string(),
    erp_code: z.string().nullable(),
    responsible_name: z.string(),
    email: z.string(),
    telephone: z.string(),
    cnpj: z.string(),
    is_active: z.boolean(),
    ...purgeFields,
    timezone: z
      .string()
      .describe("Fuso horário da empresa (IANA), um dos fusos do Brasil."),
    vehicle_limit: z.number().describe(VEHICLE_LIMIT_DESCRIPTION),
    vehicle_count: z
      .number()
      .describe("Veículos ativos (ocupando vaga do plano)."),
    created_at: responseDateTime(),
    updated_at: responseDateTime(),
  }),
  /** The list's `meta.searchMeta`, as summarizeBusinessList builds it. */
  businessListSearchMeta: searchMetaDoc(
    {
      total: z
        .number()
        .int()
        .describe("Empresas da busca e dos filtros (o cartão de total)."),
      withErpCode: z
        .number()
        .int()
        .describe("Das quais com código ERP cadastrado."),
      topStates: z
        .array(z.object({ value: z.string(), count: z.number().int() }))
        .describe(
          "Os até três estados (UF) com mais empresas, do maior para o menor — com a busca e o filtro de situação, sem o de UF.",
        ),
      topCities: z
        .array(z.object({ value: z.string(), count: z.number().int() }))
        .describe(
          'As até três cidades ("Cidade/UF") com mais empresas, do maior para o menor.',
        ),
    },
    ["status", "uf"],
  ),
  listBusinessCodedErrors: codedError(
    "VALIDATION_ERROR: ordenação ou filtro fora do que a lista oferece (`sort`, `status`, `uf`).",
  ),
  businessUpdated: z.object({
    message: z.string().default("Empresa atualizada com sucesso!"),
  }),
  businessDeleted: z.object({
    message: z.string().default("Empresa deletada com sucesso!"),
  }),
  businessToggled: z.object({
    message: z.string().default("Status da empresa atualizado com sucesso!"),
    is_active: z.boolean(),
  }),
  businessToggleConflict: codedError(
    "TOGGLE_CONFLICT: o status mudou enquanto a tela estava aberta. BUSINESS_PURGE_SCHEDULED: a exclusão da empresa está agendada; use a reativação (POST /business/cancel-business-purge/:businessId). BUSINESS_PURGE_RUNNING ou BUSINESS_PURGED: a exclusão já começou ou terminou.",
  ),
  businessPurgeScheduled: z.object({
    message: z.string(),
    data: z.object({
      id: z.string(),
      is_active: z.boolean(),
      ...purgeFields,
    }),
  }),
  businessPurgeCancelled: z.object({
    message: z.string(),
    data: z.object({
      id: z.string(),
      is_active: z.boolean(),
      ...purgeFields,
    }),
  }),
  schedulePurgeErrors: codedError(
    "VALIDATION_ERROR: corpo ou parâmetro inválido (com `issues`). BUSINESS_PURGE_CONFIRMATION_MISMATCH: a confirmação não é a razão social da empresa.",
  ),
  schedulePurgeConflict: codedError(
    "BUSINESS_PURGE_ALREADY_SCHEDULED: a exclusão já está agendada. BUSINESS_PURGE_RUNNING: a exclusão já começou. BUSINESS_PURGED: os dados já foram excluídos.",
  ),
  cancelPurgeConflict: codedError(
    "BUSINESS_PURGE_NOT_SCHEDULED: a empresa não tem exclusão agendada (uma empresa só desativada volta pelo ativar). BUSINESS_PURGE_RUNNING: a exclusão já começou e não pode mais ser desfeita. BUSINESS_PURGED: os dados já foram excluídos.",
  ),

  // Common error responses
  internalServerError: internalErrorResponse,
  resourceNotFound: errorResponse,
  validationError: z.object({
    message: z.string().default("Os dados enviados são inválidos."),
    issues: z.array(z.string()),
  }),
  businessNotFound: codedError(
    "BUSINESS_NOT_FOUND: a empresa do caminho não existe.",
  ),

  // Grouping errors by route
  createBusinessErrors: z.union([
    z.object({
      message: z.string().default("Os dados enviados são inválidos."),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este cnpj já foi cadastrado em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta razão social já foi cadastrada em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este código erp já foi cadastrado em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este e-mail já foi cadastrado em uma empresa!"),
    }),
    // Branch errors
    z.object({
      message: z
        .string()
        .default(
          "Esta razão social não está disponível para cadastro. Se a filial já é da sua empresa, procure-a na listagem; se não, fale com o suporte.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este CNPJ não está disponível para cadastro. Se a filial já é da sua empresa, procure-a na listagem; se não, fale com o suporte.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Já existe uma filial da sua empresa com este código ERP."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este e-mail não está disponível para cadastro de filial. Use outro e-mail ou fale com o suporte.",
        ),
    }),
  ]),
  listBusinessErrors: z.union([
    z.object({
      message: z.string().default("Os dados enviados são inválidos."),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),
  updateBusinessErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default("Este cnpj já foi cadastrado em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta razão social já foi cadastrada em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este código erp já foi cadastrado em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este e-mail já foi cadastrado em uma empresa!"),
    }),
    // Branch errors
    z.object({
      message: z
        .string()
        .default(
          "Esta razão social não está disponível para cadastro. Se a filial já é da sua empresa, procure-a na listagem; se não, fale com o suporte.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este CNPJ não está disponível para cadastro. Se a filial já é da sua empresa, procure-a na listagem; se não, fale com o suporte.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Já existe uma filial da sua empresa com este código ERP."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este e-mail não está disponível para cadastro de filial. Use outro e-mail ou fale com o suporte.",
        ),
    }),
  ]),
  /** A parameter the route refuses before looking anything up. */
  businessParamErrors: codedError(
    "VALIDATION_ERROR: parâmetro ou corpo inválido (com `issues`).",
  ),
  /** The company of the path does not exist (decision 11.3: 404 with a code). */
  businessNotFoundCodedPath: codedError(
    "BUSINESS_NOT_FOUND: a empresa do caminho não existe.",
  ),

  // AI Limit responses
  aiLimitUpdated: z.object({
    message: z.string().default("Limite de análise IA atualizado com sucesso!"),
    data: z.object({
      id: z.string(),
      corporate_reason: z.string(),
      fantasy_name: z.string().nullable(),
      ai_analysis_limit: z.number().describe(AI_LIMIT_DESCRIPTION),
    }),
  }),
  vehicleLimitUpdated: z.object({
    message: z.string().default("Limite de veículos atualizado com sucesso!"),
    data: z.object({
      id: z.string(),
      corporate_reason: z.string(),
      fantasy_name: z.string().nullable(),
      vehicle_limit: z.number().describe(VEHICLE_LIMIT_DESCRIPTION),
    }),
  }),
  moduleImpactData: z.object({
    data: z.object({
      module: z.string(),
      records: z.array(z.object({ label: z.string(), count: z.number() })),
      affectedUsers: z.number(),
      inFlight: z.array(z.object({ label: z.string(), count: z.number() })),
    }),
  }),
  entitlementsData: z.object({
    data: z.object({
      modules: z.array(
        z.object({
          module: z.string().describe("FLEET | DELIVERIES"),
          enabled: z.boolean(),
        }),
      ),
      vehicle_limit: z.number().describe(VEHICLE_LIMIT_DESCRIPTION),
      vehicle_count: z
        .number()
        .describe(
          "Veículos que ocupam vaga do plano: todos menos os INACTIVE (ACTIVE, BLOCKED e IN_ROUTE). Pode passar de `vehicle_limit` quando o limite foi reduzido abaixo da frota.",
        ),
      vehicle_inactive_count: z
        .number()
        .describe("Veículos inativos (histórico preservado, sem ocupar vaga)."),
      vehicle_limit_enabled: z
        .boolean()
        .describe(
          "Se há limite configurado (`vehicle_limit` > 0); falso = frota sem limite.",
        ),
      vehicle_status_counts: z
        .object({
          ACTIVE: z.number().describe("Ativos (ocupam vaga)"),
          BLOCKED: z.number().describe("Bloqueados (ocupam vaga)"),
          IN_ROUTE: z.number().describe("Em rota (ocupam vaga)"),
          INACTIVE: z.number().describe("Inativos (não ocupam vaga)"),
        })
        .describe(
          "Veículos da empresa por situação, na mesma contagem de `vehicle_count` e `vehicle_inactive_count`; a soma é o total cadastrado.",
        ),
    }),
  }),
  entitlementUpdated: z.object({
    message: z.string().default("Módulo da empresa atualizado com sucesso!"),
  }),
  businessSettingsData: z.object({ data: businessSettingsView }),
  businessSettingsSaved: z.object({
    message: z.string().default("Configurações da empresa salvas com sucesso!"),
    data: businessSettingsView,
  }),
  aiUsageData: z.object({
    data: z.object({
      id: z.string(),
      corporate_reason: z.string(),
      fantasy_name: z.string().nullable(),
      ai_analysis_limit: z.number().describe(AI_LIMIT_DESCRIPTION),
      ai_analysis_used: z
        .number()
        .describe(
          "Fotos analisadas no período (uma unidade da cota por foto: odômetro, item de checklist ou canhoto).",
        ),
      ai_analysis_in_progress: z
        .number()
        .describe(
          "Unidades reservadas por análises em andamento — voltam ao saldo se a análise falhar.",
        ),
      ai_analysis_reset_at: z
        .string()
        .datetime()
        .nullable()
        .describe(
          "Quando o período atual começou (ISO 8601, UTC): 00:00 do dia 1º no fuso da empresa.",
        ),
      ai_analysis_next_reset_at: z
        .string()
        .datetime()
        .nullable()
        .describe(
          "Quando a cota zera (ISO 8601, UTC): 00:00 do dia 1º do próximo mês no fuso da empresa.",
        ),
      ai_analysis_timezone: z
        .string()
        .nullable()
        .describe("Fuso da empresa em que o mês da cota é contado."),
      ai_analysis_remaining: z
        .number()
        .describe(
          "Fotos que ainda podem ser lidas no período: o limite menos as lidas e as em andamento, nunca abaixo de 0 (um limite reduzido abaixo do uso dá 0).",
        ),
      ai_analysis_enabled: z
        .boolean()
        .describe(
          "Se a IA está ligada para a empresa (`ai_analysis_limit` > 0). Falso = nenhuma foto é lida e os registros chegam sem sugestão.",
        ),
      ai_analysis_used_by_type: z
        .object({
          fuel: z.number().describe("Fotos de odômetro de abastecimentos."),
          checklist: z.number().describe("Fotos de itens de checklist."),
          proof: z.number().describe("Fotos de canhotos de entrega."),
        })
        .describe("Fotos analisadas no período, por tipo de registro."),
    }),
  }),
  // Two-step deletion flow
  businessDeletionCodeSent: z.object({
    message: z
      .string()
      .default(
        "Um código de confirmação foi enviado para o seu e-mail. O código expira em 5 minutos.",
      ),
  }),
  businessHasChildrenConflict: codedError(
    "BUSINESS_IN_USE: a empresa ainda tem filiais, usuários ou motoristas vinculados; a mensagem traz as contagens.",
  ),
  businessDeletionConflict: codedError(
    "BUSINESS_IN_USE: a empresa ainda tem filiais, usuários ou motoristas vinculados; a mensagem traz as contagens. BUSINESS_DELETION_NOT_REQUESTED: não há pedido de exclusão desta empresa por este usuário — peça a exclusão (POST) antes de confirmar. BUSINESS_PURGE_ALREADY_SCHEDULED, BUSINESS_PURGE_RUNNING, BUSINESS_PURGED: a exclusão desta empresa já foi agendada, já começou ou já terminou; o código não começa outra.",
  ),
  requestBusinessDeletionErrors: codedError(
    "VALIDATION_ERROR: parâmetro inválido (com `issues`).",
  ),
  confirmBusinessDeletionErrors: codedError(
    "VALIDATION_ERROR: código ausente ou fora do formato. BUSINESS_DELETION_CODE_INVALID: o código não confere. BUSINESS_DELETION_CODE_EXPIRED: passaram os 5 minutos; peça a exclusão de novo para receber outro código.",
  ),
};

export { businessSchemas, businessResponses };
