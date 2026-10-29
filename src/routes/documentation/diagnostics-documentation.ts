import { z } from "zod";

import { errorResponse } from "./common-responses";

/**
 * What a client may tell us about failures on its side (OBS-12). A summary,
 * never content: counts, HTTP statuses, hosts and short messages the client
 * already scrubbed. Every bound is small on purpose — this is a log line, and
 * an unbounded body from every phone of the fleet is a log flood.
 */
const clientError = z.object({
  kind: z
    .enum(["upload", "api", "network", "unknown"])
    .describe(
      "upload = PUT ao storage; api = resposta da API; network = sem resposta.",
    ),
  event: z
    .string()
    .max(40)
    .regex(/^[a-z_]+$/)
    .optional()
    .describe("Nome do evento de telemetria do app (ex.: outbox_item_failed)."),
  code: z
    .string()
    .max(60)
    .optional()
    .describe("Código estável do erro, quando houver (ex.: RATE_LIMITED)."),
  status: z
    .number()
    .int()
    .min(100)
    .max(599)
    .optional()
    .describe("HTTP status recebido, quando houve resposta."),
  host: z
    .string()
    .max(100)
    .optional()
    .describe(
      "Host chamado (sem caminho nem query: uma URL assinada é segredo).",
    ),
  message: z
    .string()
    .max(200)
    .describe("Mensagem curta, já sem dados pessoais."),
  count: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .describe("Ocorrências desde o último relato."),
});

const counter = z.number().int().min(0).max(1_000_000_000);

const diagnosticsSchemas = {
  clientReport: z.object({
    platform: z.enum(["android", "ios", "web"]),
    appVersion: z
      .string()
      .max(120)
      .optional()
      .describe("Versão/build/runtime/update do app, como o app se descreve."),
    outbox: z
      .object({
        pending: counter,
        failed: counter,
        stuck: counter.describe(
          "Pendentes com várias tentativas ou antigos demais.",
        ),
        oldestAgeSec: counter.describe(
          "Idade do item mais antigo da fila, em segundos.",
        ),
      })
      .optional()
      .describe("Fila offline do app (só mobile)."),
    errors: z.array(clientError).max(10),
  }),
};

const diagnosticsResponses = {
  accepted: z.object({ received: z.literal(true) }),
  error: errorResponse,
};

export { diagnosticsResponses, diagnosticsSchemas };
