import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import { occurredAtField } from "@/shared/delivery/occurred-at";
import { facetField, idFacetField } from "@/shared/pagination/list-query";
import { pageField, pageSizeField } from "@/shared/pagination/page-size";

import { DRIVER_PAUSE_KINDS } from "../dtos/driver-pause-dto";
import { PAUSE_NOTE_MAX, normalizePauseNote } from "../rules/pause-rules";
import { PAUSE_FLAG_CODES, PAUSE_REPORT_MAX_DAYS } from "../rules/pause-report-rules";

/**
 * The pause routes' inputs. Mirrored by the app (docs/contratos-app/pauses.md),
 * which validates before queueing: from the offline outbox a 400 is a
 * permanent failure, so only what can really be wrong is refused.
 */

const businessParam = z.object({
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido.")
    .describe("ID da empresa; fora do MASTER, só a do próprio usuário."),
});

const kind = z
  .enum(DRIVER_PAUSE_KINDS, {
    errorMap: () => ({ message: "Tipo de pausa inválido. Use MEAL, REST ou OTHER." }),
  })
  .describe("MEAL (refeição), REST (descanso) ou OTHER (outra).");

/** Decision 14.4: the company's PAUSE type the driver chose (contract 3). */
const occurrenceTypeId = z
  .string()
  .uuid("O tipo de pausa é inválido.")
  .optional()
  .describe(
    "O tipo de ocorrência da categoria Pausa escolhido (contrato 3 do app). A natureza gravada é a do tipo. Ausente, o app instalado manda só `kind` e a pausa vai para o tipo padrão dessa natureza.",
  );

/** Either the type (contract 3) or the nature alone (the installed app). */
const typeOrKind = (value: { kind?: unknown; occurrence_type_id?: unknown }) =>
  value.kind !== undefined || value.occurrence_type_id !== undefined;

const typeOrKindMessage = {
  message: "Informe o tipo de pausa (occurrence_type_id) ou a natureza (kind).",
  path: ["kind"],
};

const submissionKey = (what: string) =>
  z
    .string({ required_error: `A chave do envio (${what}) é obrigatória.` })
    .uuid(`A chave do envio (${what}) é inválida.`);

/**
 * A coordinate, or nothing. `null` and "" mean "no fix" (a phone without a
 * location): `z.coerce` alone would turn them into 0, a point in the Atlantic.
 */
const coordinate = (limit: number) =>
  z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.coerce.number().min(-limit).max(limit).optional(),
  );

const latitude = coordinate(90);
const longitude = coordinate(180);

/** Cleaned, not refused (see normalizePauseNote); only a real excess is a 400. */
const note = z
  .string()
  .max(1_000, `A observação deve ter no máximo ${PAUSE_NOTE_MAX} caracteres.`)
  .nullish()
  .transform((value) => normalizePauseNote(value))
  .refine((value) => value === null || value.length <= PAUSE_NOTE_MAX, {
    message: `A observação deve ter no máximo ${PAUSE_NOTE_MAX} caracteres.`,
  })
  .describe(
    `Observação livre do motorista (até ${PAUSE_NOTE_MAX} caracteres). Espaços nas pontas e repetidos são limpos, e quebras de linha viram espaço; vazia vira nula.`,
  );

const startPauseBody = z.object({
  kind: kind.optional(),
  occurrence_type_id: occurrenceTypeId,
  start_submission_id: submissionKey("início").describe(
    "Chave de idempotência do INÍCIO (UUID), gerada uma vez pelo app no toque e repetida em cada reenvio. Reenviar a mesma chave devolve a mesma pausa; é também por ela que o fim aponta a pausa.",
  ),
  occurred_at: occurredAtField,
  latitude: latitude.describe("Latitude no início (opcional)."),
  longitude: longitude.describe("Longitude no início (opcional)."),
  note,
}).refine(typeOrKind, typeOrKindMessage);

const endPauseBody = z.object({
  ...tenantLockedShape,
  start_submission_id: submissionKey("início").describe(
    "A chave com que o INÍCIO desta pausa foi enviado: é assim que o fim aponta a pausa, inclusive sem sinal (o app não conhece o id da pausa enquanto o início não chegou).",
  ),
  end_submission_id: submissionKey("fim").describe(
    "Chave de idempotência do FIM (UUID), gerada uma vez no toque e repetida em cada reenvio.",
  ),
  occurred_at: occurredAtField,
  latitude: latitude.describe("Latitude no fim (opcional)."),
  longitude: longitude.describe("Longitude no fim (opcional)."),
  start: z
    .object({
      kind: kind.optional(),
      occurrence_type_id: occurrenceTypeId,
      occurred_at: occurredAtField,
      latitude: latitude.describe("Latitude no início (opcional)."),
      longitude: longitude.describe("Longitude no início (opcional)."),
      note,
    })
    .refine(typeOrKind, typeOrKindMessage)
    .optional()
    .describe(
      "O início repetido, como foi enviado. Usado só quando o fim chega antes do início (a fila do app segue adiante depois de uma falha): a pausa é criada já encerrada e o início, quando chegar, a encontra. Recomendado sempre.",
    ),
});

const dayKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A data deve estar no formato AAAA-MM-DD.");

const reportQuery = z.object({
  from: dayKey
    .optional()
    .describe(
      "Primeiro dia (AAAA-MM-DD), no fuso da empresa. Ausente: seis dias antes de `to` (uma semana).",
    ),
  to: dayKey
    .optional()
    .describe("Último dia (AAAA-MM-DD), no fuso da empresa. Ausente: hoje da empresa."),
  driverId: idFacetField("Motoristas."),
  flag: facetField(
    PAUSE_FLAG_CODES,
    "Só os dias com um destes alertas.",
  ),
  page: pageField().optional(),
  pageSize: pageSizeField(10).optional(),
});

export {
  PAUSE_REPORT_MAX_DAYS,
  businessParam,
  endPauseBody,
  reportQuery,
  startPauseBody,
};
