import { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";

import {
  diagnosticsResponses,
  diagnosticsSchemas,
} from "./documentation/diagnostics-documentation";

type ClientReport = z.infer<typeof diagnosticsSchemas.clientReport>;

/**
 * Failures only a client can see (OBS-12).
 *
 * A photo's PUT goes straight from the phone (or the browser) to the bucket,
 * so a refused credential or a broken bucket policy never reaches this API:
 * the phone's outbox retried in silence and the operation learned about it
 * when a customer asked for a proof. The app's logger only wrote to the
 * phone's console. A client now sends a summary here — counts and the last
 * errors by kind — and it becomes one warn line, `event: client.diagnostics`,
 * with the user and tenant the session already put on the request logger.
 *
 * No table: the log is the sink, and the line is what a log search or an
 * alert keys on. Per user and bounded, so a fleet of phones cannot flood it.
 */
async function diagnosticsRoutes(app: FastifyInstance) {
  app.post(
    "/client",
    {
      config: {
        rateLimit: getRateLimiterConfig({
          max: 30,
          timeWindow: 60 * 60 * 1000,
          // After the session is known: one budget per person, not per NAT.
          hook: "preHandler",
          keyGenerator: (request: FastifyRequest) =>
            `client-diagnostics:${request.user?.id ?? request.ip}`,
        }),
      },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["diagnostics"],
        summary: "Relata falhas vistas pelo cliente",
        description:
          "Resumo de falhas que só o cliente vê (upload direto ao storage recusado, fila offline presa). Vira uma linha de log `client.diagnostics` com usuário e empresa; nada é gravado em tabela. Limite: 30 relatos por hora por usuário.",
        body: diagnosticsSchemas.clientReport,
        response: {
          202: diagnosticsResponses.accepted,
          400: diagnosticsResponses.error,
          401: diagnosticsResponses.error,
          429: diagnosticsResponses.error,
        },
      },
    },
    async (request, reply) => {
      const report = request.body as ClientReport;

      request.log.warn(
        {
          event: "client.diagnostics",
          platform: report.platform,
          appVersion: report.appVersion ?? null,
          outbox: report.outbox ?? null,
          errors: report.errors,
        },
        "client reported failures",
      );

      return reply.status(202).send({ received: true });
    },
  );
}

export { diagnosticsRoutes };
