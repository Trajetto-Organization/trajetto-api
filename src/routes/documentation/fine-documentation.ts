import { z } from "zod";

import { createFineSchema } from "@/schemas/create-fine-schema";
import { updateFineSchema } from "@/schemas/update-fine-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { listFineSchema } from "@/schemas/list-fine-schema";
import { exportFineQuerySchema } from "@/schemas/export-fine-schema";

import { searchMetaDoc } from "@/shared/pagination/list-meta";
import { FINE_STATUSES } from "@/modules/fine/usecases/list-fine/fine-list";

import { errorResponse } from "./common-responses";

const fineBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  fineId: z.string().uuid("ID da multa deve ser um UUID válido."),
});

const fineSchemas = {
  createFine: createFineSchema,
  updateFine: updateFineSchema,
  updateDeleteBusiness: updateDeleteBusinessSchema,
  listFines: listFineSchema,
  fineBusinessParams: fineBusinessParams,
  exportFinesQuery: exportFineQuerySchema,
};

const dateValue = z.union([z.string(), z.date()]);

/** One line of GET /fines/list-fine, as FineRepository.listFines selects it. */
const fineRow = z.object({
  id: z.string().describe("ID da multa."),
  status: z
    .enum(FINE_STATUSES)
    .describe(
      "Situação no dia de negócio da empresa: PAID (paga), PENDING (em aberto até o dia do vencimento), OVERDUE (em aberto depois dele).",
    ),
  violation_date: dateValue.describe("Data da infração: o instante em que o dia começa no fuso da empresa."),
  due_date: dateValue.describe("Data de vencimento: o instante em que o dia começa no fuso da empresa."),
  payment_date: dateValue.nullable().describe("Data do pagamento; null se não paga."),
  violation_day: z
    .string()
    .describe("Dia da infração (AAAA-MM-DD) no fuso da empresa: o que a tela mostra."),
  due_day: z.string().describe("Dia do vencimento (AAAA-MM-DD) no fuso da empresa."),
  payment_day: z
    .string()
    .nullable()
    .describe("Dia do pagamento (AAAA-MM-DD) no fuso da empresa; null se não paga."),
  amount: z.number().describe("Valor da multa, em reais."),
  points: z.number().int().describe("Pontos na CNH."),
  location: z.string().nullable().describe("Local da infração."),
  observation: z.string().nullable().describe("Observações."),
  businessId: z.string().describe("Empresa."),
  branchId: z.string().describe("Filial."),
  driverId: z.string().describe("Motorista."),
  vehicleId: z.string().describe("Veículo."),
  trafficViolationCodeId: z.string().describe("Código de infração."),
  latitude: z.number().nullable().describe("Latitude do ponto da infração."),
  longitude: z.number().nullable().describe("Longitude do ponto da infração."),
  latitude_original: z.number().nullable().describe("Latitude capturada pelo GPS do app."),
  longitude_original: z.number().nullable().describe("Longitude capturada pelo GPS do app."),
  location_source: z
    .string()
    .nullable()
    .describe("GPS_AUTO, GPS_MANUAL, USER_MANUAL ou NONE."),
  location_edited_by: z.string().nullable().describe("Quem posicionou o ponto à mão."),
  location_edited_at: dateValue.nullable().describe("Quando o ponto foi posicionado à mão."),
  created_from: z.string().describe("MOBILE_APP ou WEB_DASHBOARD."),
  client_submission_id: z.string().nullable().describe("Chave de idempotência do cadastro."),
  created_at: dateValue.describe("Criação."),
  updated_at: dateValue.describe("Última alteração."),
  branch: z.object({ corporate_reason: z.string() }).describe("Filial."),
  driver: z.object({ name: z.string(), cpf: z.string() }).describe("Motorista."),
  vehicle: z
    .object({ license_plate: z.string(), description: z.string() })
    .describe("Veículo."),
  trafficViolationCode: z
    .object({
      code: z.string(),
      sub_code: z.number().int(),
      description: z.string(),
      gravity: z.string(),
      points: z.number().int(),
    })
    .describe("Código de infração (tabela nacional)."),
});

/** The `meta.searchMeta` summarizeFineList builds: the cards and the filter options. */
const fineListSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe("Multas da busca e dos demais filtros, sem o de situação (o total dos cartões)."),
    paid: z.number().int().describe("Das quais pagas."),
    pending: z.number().int().describe("Das quais em aberto até o dia do vencimento."),
    overdue: z.number().int().describe("Das quais em aberto depois do dia do vencimento."),
    totalAmount: z.number().describe("Soma dos valores dessas multas."),
    openAmount: z.number().describe("Soma dos valores das que não foram pagas."),
  },
  ["status", "branchId", "trafficViolationCodeId"],
);

const message = (text: string) =>
  z.object({ message: z.string().default(text) });

const fineResponses = {
  fineRow,
  fineListSearchMetaDoc,
  fineCreated: message("Multa registrada com sucesso!"),
  fineUpdated: message("Multa atualizada com sucesso!"),
  fineDeleted: message("Multa deletada com sucesso!"),
  error: errorResponse,
};

export { fineSchemas, fineResponses };
