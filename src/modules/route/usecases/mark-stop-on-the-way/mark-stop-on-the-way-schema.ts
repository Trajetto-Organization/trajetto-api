import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import { occurredAtField } from "@/shared/delivery/occurred-at";
import { routeIdParamSchema, routeStopIdParamSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { errorResponse } from "@/routes/documentation/common-responses";

const coordinate = (label: string, bound: number) =>
  z.coerce
    .number({ invalid_type_error: `A ${label} deve ser um número.` })
    .min(-bound, `A ${label} é inválida.`)
    .max(bound, `A ${label} é inválida.`)
    .nullable()
    .optional();

/**
 * What the app sends when the driver taps "Estou a caminho".
 *
 * The location is optional, unlike the arrival's: the mark says where the
 * driver is GOING, and refusing it because the phone had no fix yet would
 * turn an informative tap into a failure on the driver's pending screen. When
 * it comes, it comes as a pair.
 */
const markStopOnTheWaySchema = z
  .object({
    ...tenantLockedShape,
    client_submission_id: z
      .string({
        required_error: "A chave de idempotência do envio é obrigatória.",
      })
      .uuid("A chave de idempotência do envio é inválida.")
      .describe(
        "Chave de idempotência do envio (UUID), gerada uma vez pelo app e repetida em cada retentativa: reenviar a mesma chave devolve a mesma resposta sem gravar de novo.",
      ),
    latitude: coordinate("latitude", 90).describe(
      "Onde o motorista estava ao tocar (opcional; vem junto com a longitude).",
    ),
    longitude: coordinate("longitude", 180).describe(
      "Onde o motorista estava ao tocar (opcional; vem junto com a latitude).",
    ),
    occurred_at: occurredAtField,
  })
  .superRefine((value, ctx) => {
    const hasLatitude = value.latitude != null;
    const hasLongitude = value.longitude != null;

    if (hasLatitude !== hasLongitude) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasLatitude ? "longitude" : "latitude"],
        message: "Envie a latitude e a longitude juntas, ou nenhuma das duas.",
      });
    }
  });

const markStopOnTheWayParams = updateDeleteBusinessSchema
  .merge(routeIdParamSchema)
  .merge(routeStopIdParamSchema);

const isoDateTime = z.union([z.string(), z.date()]);

const markStopOnTheWayResponses = {
  marked: z.object({
    message: z.string().default("Parada marcada como a caminho."),
    data: z.object({
      stopId: z.string(),
      routeId: z.string(),
      deliveryId: z.string(),
      on_the_way_at: isoDateTime.describe(
        "O instante que esta marcação registrou (o toque, corrigido pelo relógio do aparelho). Um reenvio com a mesma chave devolve este mesmo valor.",
      ),
    }),
  }),

  badRequest: errorResponse.describe(
    "VALIDATION_ERROR: corpo ou parâmetros inválidos (inclusive latitude sem longitude).",
  ),

  forbidden: errorResponse.describe(
    "PERMISSION_DENIED: só o motorista marca a caminho (um usuário do escritório também recebe este código) ou o perfil não tem escrita em entregas. MODULE_NOT_ENABLED: a empresa não contratou Entregas. TENANT_ACCESS_DENIED: a URL nomeia outra empresa. TENANT_INACTIVE: a empresa está desativada.",
  ),

  notFound: errorResponse.describe(
    "ROUTE_STOP_NOT_FOUND: a parada não existe, não é desta rota, é de outra empresa ou a rota é de outro motorista — a mesma resposta nos quatro casos. USER_NOT_FOUND: o usuário da sessão deixou de existir.",
  ),

  conflict: errorResponse.describe(
    "ROUTE_NOT_IN_PROGRESS: a rota não está em andamento (ainda não saiu, ou já terminou). ROUTE_STOP_NOT_PENDING: a parada já teve chegada, entrega, insucesso ou foi cancelada. SUBMISSION_ID_REUSED: a chave de idempotência já foi usada em outro envio — gere uma chave nova. Nos três casos repetir não muda a resposta; para o app, as duas primeiras significam que a marcação perdeu o sentido e pode ser descartada.",
  ),

  rateLimited: errorResponse,

  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export {
  markStopOnTheWayParams,
  markStopOnTheWayResponses,
  markStopOnTheWaySchema,
};
