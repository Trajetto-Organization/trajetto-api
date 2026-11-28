import { z } from "zod";

import { MAX_PINGS_PER_BATCH } from "@/shared/route/driver-position-rules";
import { listPeriodFields, refineListPeriod } from "@/shared/time/list-period";

import { ROUTE_PERIOD_DESCRIPTION } from "@/schemas/route-schema";
import { fieldError } from "@/shared/validation/field-error";

/**
 * What the app flushes.
 *
 * Deliberately permissive about the CONTENT of a ping and strict only about
 * its shape: the app is offline-first and resends, so refusing a batch because
 * one point has a bad accuracy reading would have the phone retry the same bad
 * point forever. `acceptPings` decides what is usable, one point at a time.
 *
 * No driverId. It comes from the session, always — a body-supplied one on this
 * route would let any phone write anybody's trail, and the trail is what a
 * dispute is settled with.
 */
const pingSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),

  accuracy: z.number().nullable().optional(),
  speed: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),

  battery: z.number().nullable().optional(),

  recorded_at: z
    .string(
      fieldError({ required: "Cada ponto precisa da hora em que foi medido." }),
    )
    .datetime({ message: "A hora do ponto deve ser uma data ISO 8601." }),
});

const recordDriverPositionsSchema = z.object({
  pings: z
    .array(pingSchema)
    .min(1, "Envie ao menos um ponto.")
    .max(
      MAX_PINGS_PER_BATCH,
      `Envie no máximo ${MAX_PINGS_PER_BATCH} pontos por vez.`,
    ),
});

const controlTowerSchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),
});

/**
 * GET /route/live (wave 4): the company as the tower receives it, and the
 * cursor of the next page. No page size: the cap is the server's (500).
 */
const liveRoutesSchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),

  cursor: z
    .string()
    .min(1, "Cursor inválido.")
    .max(512, "Cursor inválido.")
    .optional()
    .describe(
      "O `meta.nextCursor` da resposta anterior: a página seguinte começa depois da última rota vista (em andamento primeiro, depois liberadas, cada grupo por código), sem repetir nem pular.",
    ),
});

const driverTrailParamSchema = z.object({
  driverId: z.string().uuid("ID do motorista é inválido."),
});

const driverTrailQuerySchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),

  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "A data deve estar no formato AAAA-MM-DD.")
    .optional()
    .describe(
      "O dia do trajeto (AAAA-MM-DD), no fuso da empresa; ausente, o dia de hoje da empresa.",
    ),

  routeId: z
    .string()
    .uuid("ID da rota é inválido.")
    .optional()
    .describe(
      "Só os pontos gravados durante ESTA rota (decisão 14.7), da saída à conclusão; o dia é ignorado. Rota de outra empresa ou de outro motorista: 404.",
    ),
});

/**
 * At most fifty routes a page (twenty by default, below): each card carries
 * every stop of its route, so a page is heavier than a table row.
 */
const MONITORING_PAGE_SIZE_MAX = 50;

const routeMonitoringSchema = z
  .object({
    businessId: z
      .string()
      .uuid("ID da empresa é inválido.")
      .optional()
      .describe("Só o MASTER envia; ausente, a empresa do usuário."),

    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "A data deve estar no formato AAAA-MM-DD.")
      .optional()
      .describe(
        "O dia da operação (AAAA-MM-DD), no fuso da empresa; ausente, hoje — e aí entram também as rotas ainda em andamento de dias anteriores.",
      ),

    page: z.coerce
      .number(fieldError({ invalid: "A página deve ser um número." }))
      .int("A página deve ser um número inteiro.")
      .min(1, "A página começa em 1.")
      .max(10_000, "Página fora do intervalo.")
      .default(1)
      .describe("A página, a partir de 1."),

    pageSize: z.coerce
      .number(
        fieldError({ invalid: "O tamanho da página deve ser um número." }),
      )
      .int("O tamanho da página deve ser um número inteiro.")
      .min(1, "O tamanho da página deve ser ao menos 1.")
      .max(
        MONITORING_PAGE_SIZE_MAX,
        `O tamanho da página deve ser no máximo ${MONITORING_PAGE_SIZE_MAX}.`,
      )
      .default(20)
      .describe(
        "Rotas por página (padrão 20, no máximo 50): cada uma traz todas as paradas.",
      ),

    // The board's period (plan of 09/11/2026), the routes list's own rule.
    ...listPeriodFields(
      `${ROUTE_PERIOD_DESCRIPTION} Com today, o quadro é o mesmo de sem período. Não vale junto com day.`,
    ),
  })
  .superRefine(refineListPeriod())
  .superRefine(({ day, period }, ctx) => {
    // One question at a time: the legacy day, or a period.
    if (day !== undefined && period !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["day"],
        message: "Envie day ou period, não os dois.",
      });
    }
  });

/** The board by driver: one company's day, no paging (one row per driver). */
const driverMonitoringSchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),

  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "A data deve estar no formato AAAA-MM-DD.")
    .optional()
    .describe(
      "O dia da operação (AAAA-MM-DD), no fuso da empresa; ausente, hoje — e aí entram também o que está na rua agora e as paradas abertas de rotas ainda em andamento.",
    ),
});

export {
  MONITORING_PAGE_SIZE_MAX,
  controlTowerSchema,
  driverMonitoringSchema,
  driverTrailParamSchema,
  driverTrailQuerySchema,
  liveRoutesSchema,
  recordDriverPositionsSchema,
  routeMonitoringSchema,
};
