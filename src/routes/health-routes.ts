import { FastifyInstance } from "fastify";

import { z } from "zod";

import database from "@/../infra/database";
import { RedisConnection } from "@/../infra/cache/redis-connection";

import {
  healthResponses,
  healthSchemas,
} from "./documentation/health-documentation";

import { clientRateLimitKey } from "@/config/rate-limit";
import { env } from "@/env";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";
import { isDraining } from "@/shared/lifecycle/draining";
import { buildInfo, buildInfoShape } from "@/shared/build-info";
import { NotificationPipelineService } from "@/shared/notifications/notification-pipeline-service";
import {
  listFailedEvents,
  replayFailedEvents,
} from "@/shared/notifications/outbox-dead-letter";
import {
  deadLetterCountSql,
  deadLetterPageSql,
  type DeadLetterRow,
} from "@/shared/health/metrics-queries";
import { probeDatabase } from "@/shared/health/readiness-probe";
import { readOperationalMetrics } from "@/shared/health/operational-metrics";
import { readProviderReadiness } from "@/shared/health/provider-readiness";
import {
  readRolloutStatus,
  ROLLOUT_TOKEN_MIN_LENGTH,
  rolloutToken,
  rolloutTokenMatches,
} from "@/shared/health/rollout-status";
import { errorResponse } from "./documentation/common-responses";
import { redactEmails } from "@/shared/logging/redact-email";

interface ServiceHealth {
  status: "healthy" | "unhealthy";
  critical: boolean;
  latency?: number;
}

/**
 * What a probe found, including the failure's text. The text is for the
 * server log only (OBS-15): /health is anonymous, and "Can't reach database
 * server at `host:5432`" is the internal topology handed to anyone who asks.
 */
interface ProbeResult extends ServiceHealth {
  error?: string;
}

function publicHealth(probe: ProbeResult): ServiceHealth {
  return {
    status: probe.status,
    critical: probe.critical,
    latency: probe.latency,
  };
}

// Enough of the provider message to recognise the failure, short enough that a
// page of dead letters stays readable.
const DEAD_LETTER_ERROR_MAX_LENGTH = 500;

/**
 * A stored error as the dead letter shows it: addresses masked (OBS-15), then
 * truncated. New rows are redacted when written; rows an older release wrote
 * ("Falha ao enviar e-mail para <to>") are masked here, on the way out.
 */
function deadLetterError(lastError: string | null): string | null {
  return lastError
    ? redactEmails(lastError).slice(0, DEAD_LETTER_ERROR_MAX_LENGTH)
    : null;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * How long a single probe may take before it counts as down.
 *
 * Half a second. This endpoint is what a load balancer reads, and a probe that
 * can take four seconds is a probe that decides nothing — the balancer has
 * already given up and drawn its own conclusion. A healthy ping is single-digit
 * milliseconds, so the only thing this cuts off is a dependency that has
 * stopped answering.
 */
const PROBE_TIMEOUT_MS = 500;

async function probeService(
  critical: boolean,
  run: () => Promise<unknown>,
): Promise<ProbeResult> {
  const startedAt = Date.now();

  try {
    await Promise.race([
      run(),

      new Promise((_resolve, reject) =>
        setTimeout(
          () =>
            reject(new Error(`Probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        ),
      ),
    ]);

    return { status: "healthy", critical, latency: Date.now() - startedAt };
  } catch (error) {
    return {
      status: "unhealthy",
      critical,
      latency: Date.now() - startedAt,
      error: toErrorMessage(error),
    };
  }
}

async function healthRoutes(app: FastifyInstance) {
  /**
   * Rich diagnosis for humans and external monitors. No load balancer or
   * Docker probe reads it: the Docker healthcheck (compose and Dockerfile)
   * uses /health/liveness, which touches no dependency, and Traefik takes a
   * replica out of rotation on /health/readiness. It was once the Docker
   * healthcheck's target, and a database blip then destroyed every replica.
   *
   * The 503 criterion stays narrow: ONLY the database. Redis is probed and
   * reported because it is genuinely useful to see, but it never decides the
   * status code - a monitor paging on a dependency the API survives would
   * cry wolf. Anything non-critical that is down turns the payload
   * "degraded" and still answers 200.
   */
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Saúde do sistema",
        description:
          "Verifica as dependências do sistema, com a latência de cada uma. Responde 503 só quando o banco de dados está inacessível; uma dependência não crítica fora do ar aparece como 'degraded', com status 200.",
        response: {
          200: healthResponses.healthCheck,
          503: healthResponses.healthCheck,
        },
      },
    },
    async (request, reply) => {
      // In parallel and each on a clock. Probed one after the other, a hung
      // dependency added its whole timeout to the answer: measured at 1,03 s
      // with Redis stopped, for a check that is otherwise 220 ms. A load
      // balancer with a one-second timeout would then pull every replica out
      // of rotation over a Redis blip the API had already survived — the
      // outage the design goes out of its way not to cause.
      const [databaseHealth, redisHealth] = await Promise.all([
        probeService(true, () => database.$queryRaw`SELECT 1`),

        probeService(false, async () => {
          const client = await RedisConnection.getInstance().getClient();

          await client.ping();
        }),
      ]);

      // The failure's text goes to the log, where the operator reads it, and
      // never into the anonymous body.
      for (const [service, probe] of Object.entries({
        database: databaseHealth,
        redis: redisHealth,
      })) {
        if (probe.error) {
          request.log.warn(
            { service, err: probe.error },
            "health probe failed",
          );
        }
      }

      const services = {
        database: publicHealth(databaseHealth),
        redis: publicHealth(redisHealth),
      };

      const criticalDown = Object.values(services).some(
        (service) => service.critical && service.status === "unhealthy",
      );

      const nonCriticalDown = Object.values(services).some(
        (service) => !service.critical && service.status === "unhealthy",
      );

      const response = {
        status: criticalDown
          ? ("unhealthy" as const)
          : nonCriticalDown
            ? ("degraded" as const)
            : ("healthy" as const),
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        services,
      };

      if (criticalDown) {
        return reply.status(503).send({
          ...response,
          message:
            "Database is unreachable - this instance cannot serve traffic",
        });
      }

      if (nonCriticalDown) {
        return reply.status(200).send({
          ...response,
          message:
            "A non-critical dependency is down - traffic is still served in degraded mode",
        });
      }

      return reply.status(200).send(response);
    },
  );

  /**
   * Liveness - MUST NOT touch any dependency, ever.
   *
   * The only question it answers is "is this process still able to run
   * JavaScript and reply?". Checking the database, Redis or any broker here
   * turns an external outage into a restart loop of every replica, which is
   * strictly worse than the outage itself: restarting the process cannot fix
   * a dependency that lives somewhere else. Whoever is tempted to "improve"
   * this by adding a check wants readiness, not liveness.
   */
  app.get(
    "/health/liveness",
    {
      schema: {
        tags: ["health"],
        summary: "Sonda de vida (liveness) da aplicação",
        description:
          "Diz apenas se o processo está de pé e consegue responder. De propósito não verifica nenhuma dependência externa: uma dependência com falha nunca deve reiniciar o container. Informa também o commit do build que responde (`version`, `commit`), que o pipeline lê para confirmar o deploy, e o ambiente (`environment`), que a web confere no boot para não falar com a API de outro ambiente.",
        response: {
          // The commit is a constant read at import (build-info.ts): the
          // probe still touches nothing. The pipeline polls it after a
          // deploy until the new build answers (wait-for-version.mjs).
          200: healthResponses.livenessCheck.extend(buildInfoShape),
        },
      },
    },
    async (_request, reply) => {
      // APP_ENV was parsed at boot: still nothing touched. Staging and
      // production share dokploy-network, and the web may call this API by
      // its App Name there; the web compares this with its own APP_ENV at
      // boot and refuses to start on a mismatch, instead of sending one
      // environment's credentials to the other (trajetto-ui env-check.ts).
      return reply
        .status(200)
        .send({ status: "alive", ...buildInfo, environment: env.APP_ENV });
    },
  );

  /**
   * The release step's state, for the pipeline (plano-escala U-11): a step
   * that ended 'pending' or 'failed' makes the next deploy run the release
   * step again, even with the same release image. Behind
   * ROLLOUT_STATUS_TOKEN; without it, or with a wrong one, this is the 404
   * of a route that does not exist (callNotFound: the same handler, the same
   * body), so the route's existence is not given away. Read on the app's
   * pool: one indexed read of a handful of rows, at most 30 a minute.
   *
   * The 30 a minute counts only requests that carried the token. A
   * `config.rateLimit` would run before the handler and put the limiter's
   * `x-ratelimit-*` headers on the 404 as well (and a 429 on the 31st probe),
   * which a path nobody registered never has: whoever probes would learn
   * the route is there. So the route opts out of the plugin's hook and runs
   * its own bucket once the token matched. Probing with wrong tokens is then
   * as unlimited here as probing any missing path, and the token is 32+
   * random characters, compared in constant time.
   */
  const rolloutStatusToken = rolloutToken(env.ROLLOUT_STATUS_TOKEN);

  if (env.ROLLOUT_STATUS_TOKEN && !rolloutStatusToken) {
    app.log.warn(
      `ROLLOUT_STATUS_TOKEN has fewer than ${ROLLOUT_TOKEN_MIN_LENGTH} characters: GET /health/rollout stays closed (404)`,
    );
  }

  // Namespaced: no other `app.rateLimit()` bucket can share these keys.
  const rolloutCeiling = app.rateLimit({
    max: 30,
    timeWindow: "1 minute",
    keyGenerator: (request) => `health-rollout:${clientRateLimitKey(request)}`,
  });

  app.get(
    "/health/rollout",
    {
      // The bucket is `rolloutCeiling`, applied after the token (above).
      config: { rateLimit: false },
      // No `security` entry: the bearer is the pipeline's token, not a
      // session, and this route never answers 401 or 403 (only the 404).
      schema: {
        tags: ["health"],
        summary: "Estado da etapa de release (para o pipeline)",
        description:
          "O que a etapa de release deixou: os passos de `infra/sql` e `prisma/post-deploy` pendentes ou que falharam, e quando ela rodou pela última vez. O pipeline lê antes de cada deploy e roda a etapa de novo quando há um passo pendente. Exige `Authorization: Bearer <ROLLOUT_STATUS_TOKEN>`; sem o token configurado, sem o cabeçalho ou com um valor errado, responde o mesmo 404 de uma rota que não existe, sem os cabeçalhos do limitador. Com o token, até 30 pedidos por minuto, sem cache.",
        response: {
          200: healthResponses.rolloutStatus,
          404: errorResponse.describe(
            "ROUTE_NOT_FOUND: sem token, token errado ou token não configurado (a mesma resposta de uma rota que não existe).",
          ),
          429: errorResponse.describe(
            "RATE_LIMITED: mais de 30 pedidos com o token no último minuto. Espere o `retry-after`. Sem o token certo, a resposta é sempre o 404.",
          ),
        },
      },
    },
    async (request, reply) => {
      if (
        !rolloutTokenMatches(request.headers.authorization, rolloutStatusToken)
      ) {
        return reply.callNotFound();
      }

      // Throws the 429 (with its headers) past the ceiling.
      await rolloutCeiling.call(app, request, reply);

      const status = await readRolloutStatus(database, buildInfo.commit);

      return reply.header("cache-control", "no-store").status(200).send(status);
    },
  );

  /**
   * Readiness - checks only what is indispensable to serve traffic.
   *
   * Database: in. Every meaningful request reads or writes Postgres, so a
   * replica that cannot reach it serves nothing but errors and should be
   * pulled out of rotation.
   *
   * Redis: deliberately OUT. It is not indispensable: the rate limiter is
   * registered with `skipOnError: true`, so requests pass instead of failing,
   * and socket.io keeps serving the clients attached to this replica - only
   * the cross-replica fan-out degrades. Gating readiness on Redis would take
   * EVERY replica out of rotation at the same moment, turning a partial
   * degradation into a total outage. Redis is reported by `/health` so the
   * problem stays visible; it just does not decide who receives traffic.
   */
  app.get(
    "/health/readiness",
    {
      schema: {
        tags: ["health"],
        summary: "Sonda de prontidão (readiness) da aplicação",
        description:
          "Verifica só o banco de dados, a única dependência sem a qual esta réplica não atende nenhuma requisição. O Redis fica de fora de propósito: a API funciona degradada sem ele, e condicionar a prontidão a ele tiraria todas as réplicas do ar ao mesmo tempo.",
        response: {
          200: healthResponses.readinessCheck,
          503: healthResponses.readinessCheck,
        },
      },
    },
    async (_request, reply) => {
      // Shutting down: out of rotation BEFORE the listener closes, so the load
      // balancer stops sending new requests while the in-flight ones finish.
      if (isDraining()) {
        return reply.status(503).send({
          status: "draining",
          ready: false,
        });
      }

      // On a connection of its own, not the application's pool: a burst that
      // fills the pool used to leave this probe queued past Traefik's 5 s and
      // pull every replica out at once (OBS-11). A database that is down or
      // hung still answers false — a timeout is never read as ready.
      const isReady = await probeDatabase();

      if (!isReady) {
        return reply.status(503).send({
          status: "not ready",
          ready: false,
        });
      }

      return reply.status(200).send({
        status: "ready",
        ready: true,
      });
    },
  );

  /**
   * Operational metrics - the numbers that say WHEN to add capacity, so the
   * decision is arithmetic instead of opinion.
   *
   * - connection usage: the real ceiling of horizontal scaling (each replica
   *   holds its own Prisma pool); crossing ~70% is the cue for PgBouncer.
   * - outbox lag: depth alone lies - a thousand events processed in a second
   *   are fine; ten stuck for an hour are not. Two numbers are reported
   *   because one of them lies too (see below).
   * - per-channel delivery counters: without them nobody can answer "how many
   *   e-mails failed for good yesterday?" - the table was only ever read by
   *   the pipeline that writes it. Plus each channel's CURRENT backlog and
   *   the age of its oldest delivery: an event is PUBLISHED as soon as it
   *   fans out, so a provider outage never shows on the outbox (OBS-04).
   * - queue table bloat: dead tuples over 20% is the agreed trigger to act.
   * - workers, cron jobs and the partition runway: a worker hung on one
   *   replica, a job that stopped succeeding (OBS-10, INV-07).
   * - runtime: the event loop, the threadpool and the Prisma pool of the
   *   replica that answered — what saturates first (GAP3-10, OBS-11).
   * - the database itself (plano-escala F1-06): xid age, hit ratio, the
   *   oldest write and the oldest snapshot of the cluster, the archiver,
   *   pg_wal, the hot tables, the sizes, the parameters and
   *   pg_stat_statements — what the plan's alerts and capacity readings use.
   *
   * Every query is served by an index, with statuses as SQL literals so a
   * partial index is usable under a generic plan (OBS-09; the plan test is
   * tests/E2E/health-metrics-plans.test.ts). The queue numbers are one
   * statement and the whole read four, plus the database's own three
   * (database-metrics.ts: catalog views, no table is scanned), run one after
   * the other so the endpoint never takes more than one slot of the pool it
   * reports on, and served from a 10-second snapshot per replica
   * (operational-metrics.ts).
   *
   * MASTER-only: it exposes infrastructure posture, not tenant data.
   */
  app.get(
    "/health/metrics",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Métricas operacionais (filas e uso de conexões)",
        description:
          "Uso de conexões do Postgres em relação a max_connections; o próprio banco (idade do xid do cluster, acerto do cache, a transação de escrita e o snapshot mais antigos do cluster, arquivamento do WAL, tamanho do pg_wal quando o usuário pode ler, tabelas quentes pela raiz da partição, tamanhos medidos a cada 5 min, parâmetros sem segredo e o estado do pg_stat_statements; uma parte que falha fica null e aparece em `collection_errors`); profundidade e atraso do outbox, fila do pipeline de IA, fila e resultado das notificações por canal, mensagens de WhatsApp que a Meta recusou ou recebeu mais de uma vez (pelos callbacks de status), fila de webhooks, inchaço das tabelas de fila, workers de cada réplica, crons, partições de cada tabela particionada do registro (folga à frente, presas além da retenção, dono; `driver_position` fica como apelido por um release), runtime (com a CPU por requisição) e pool do Prisma da réplica que respondeu, o Redis (latência, memória, operações por segundo, CPU, pub/sub, saída, buffers dos clientes, política e despejos; nunca endereço nem chave), contratos legados do app ainda em uso, requisições HTTP da réplica (classes de status, latência por grupo de rota e o contrato do app nas posições dos últimos 10 minutos), concordância da pré-checagem do aparelho com a leitura do servidor e estado do certificado de assinatura do comprovante. Orienta decisões de capacidade (PgBouncer, réplicas, broker dedicado) e o disparo de vacuum. A leitura vale por 10 s em cada réplica (`timestamp` diz quando foi feita): pedidos nesse intervalo recebem a mesma.",
        response: {
          200: healthResponses.operationalMetrics,
        },
      },
    },
    async (_request, reply) => {
      // Four statements and the database's own three, one after the other,
      // served from a 10 s snapshot with one read in flight at a time
      // (operational-metrics.ts, database-metrics.ts).
      return reply.status(200).send(await readOperationalMetrics());
    },
  );

  /**
   * Provider readiness (contract §32/§33): which providers this deployment
   * has configured and whether they answer — Resend and its domain, Meta and
   * each template's approval, Expo, R2, the OCR service and its token, the
   * proof certificate and the heartbeat; LocationIQ's two (the deliveries'
   * lookups and the address search) from their state in Redis, unprobed,
   * since every call spends a credit. Read-only probes, side by side: an
   * attempt of 3.5 s and, after a failure that may clear by itself, one more
   * inside 5 s per provider. Cached 30 s (5 s when some provider is
   * transient) and shared by the replicas (Redis, fail-open) so a refreshing
   * screen never turns into calls to Meta.
   *
   * MASTER-only: it describes the shared infrastructure. Variable NAMES and
   * states only; no value, no internal host, no heartbeat URL.
   */
  app.get(
    "/health/providers",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Prontidão dos provedores externos",
        description:
          'Diz, sem expor segredos, quais provedores estão configurados e respondendo: e-mail (Resend, com o domínio do remetente), WhatsApp (Meta, com o status de cada template), push (Expo → FCM), armazenamento (R2), leitura de fotos (trajetto-ai, com o token), localização das entregas e busca do "Fixar no mapa" (LocationIQ: sem sonda, porque cada chamada gasta um crédito do dia; o estado vem do Redis, com a pausa que uma recusa ou a cota do dia gravou, o HTTP dela e o uso do dia, e o Redis fora vira "estado não lido", nunca erro), certificado ICP do comprovante e heartbeat do alerta externo. Lista os nomes das variáveis que faltam. As sondas são só de leitura e rodam em paralelo: cada tentativa tem até 3,5 s e, depois de uma falha que pode passar sozinha (tempo esgotado, rede, HTTP 5xx, resposta incompleta), há no máximo mais uma, dentro de 5 s por provedor; `attempts`, `transient` e `failure_kind` dizem como o veredito foi obtido. Uma recusa definitiva (chave, bucket, domínio) nunca é repetida nem atenuada. O relatório fica em cache por 30 s (5 s quando algum provedor está transitório), compartilhado entre as réplicas (`cached` diz se a resposta veio do cache); `refresh=true` sonda de novo, no máximo uma vez a cada 5 s. Só MASTER.',
        querystring: healthSchemas.providersQuery,
        response: {
          200: healthResponses.providerReadiness,
          401: errorResponse.describe("Sem sessão válida."),
          403: errorResponse.describe(
            "AUTH_ROLE_FORBIDDEN: só o MASTER lê a infraestrutura.",
          ),
          // Context only: the transform adds the limiter's explanation of
          // RATE_LIMITED (the wait, the limit) after it.
          429: errorResponse.describe("Muitas leituras seguidas."),
        },
      },
    },
    async (request, reply) => {
      const { refresh } = request.query as z.infer<
        typeof healthSchemas.providersQuery
      >;

      return reply.status(200).send(await readProviderReadiness({ refresh }));
    },
  );

  /**
   * Dead letter - the path from the symptom to the concrete case.
   *
   * `/health/metrics` says "eleven e-mails failed for good yesterday"; this
   * says which ones, to whom, from which event and with which provider error.
   * Without it a FAILED delivery is a row nobody will ever open.
   *
   * Read-only and MASTER-only: it crosses every tenant by design, which is
   * exactly why no other role may call it.
   */
  app.get(
    "/health/dead-letter",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Envios de notificação que falharam (dead letter)",
        description:
          "Lista paginada dos envios de notificação que esgotaram as tentativas, da falha mais recente para a mais antiga, com filtro opcional por canal. `source=archive` lê as falhas copiadas antes da limpeza noturna (guardadas por 90 dias a partir da falha) em vez das atuais. Só MASTER: abrange todas as empresas.",
        querystring: healthSchemas.deadLetterQuery,
        response: {
          200: healthResponses.deadLetter,
        },
      },
    },
    async (request, reply) => {
      const { page, pageSize, channel, source } = request.query as z.infer<
        typeof healthSchemas.deadLetterQuery
      >;

      // The archive: failed deliveries copied out before the purge took their
      // event (OUTBOX-18), kept 90 days. Same shape; failedAt is indexed.
      if (source === "archive") {
        const where = channel ? { channel } : {};

        const total = await database.notificationDeadLetter.count({ where });

        const archived = await database.notificationDeadLetter.findMany({
          where,
          orderBy: { failedAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        });

        return reply.status(200).send({
          data: archived.map((row) => ({
            id: row.id,
            channel: row.channel,
            topic: row.topic,
            businessId: row.businessId,
            userId: row.userId,
            externalRecipientId: row.externalRecipientId,
            attempts: row.attempts,
            lastError: deadLetterError(row.lastError),
            created_at: row.created_at.toISOString(),
            failedAt: row.failedAt.toISOString(),
            eventId: row.outboxEventId,
            // The archive keeps no request id.
            correlationId: null,
          })),
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
        });
      }

      // Raw SQL with the status as a literal, so the partial
      // notification_delivery_failed_idx serves the count and the page even
      // under a generic plan (OBS-09) — see metrics-queries.ts.
      const [counted] = await database.$queryRaw<Array<{ total: number }>>(
        deadLetterCountSql(channel),
      );

      const total = counted?.total ?? 0;

      // updated_at is the moment it gave up, which is the date an operator is
      // looking for - not when it was first enqueued.
      const deliveries = await database.$queryRaw<DeadLetterRow[]>(
        deadLetterPageSql(channel, pageSize, (page - 1) * pageSize),
      );

      return reply.status(200).send({
        data: deliveries.map((delivery) => ({
          id: delivery.id,
          channel: delivery.channel,
          topic: delivery.topic,
          businessId: delivery.businessId,
          userId: delivery.userId,
          externalRecipientId: delivery.externalRecipientId,
          attempts: delivery.attempts,
          lastError: deadLetterError(delivery.lastError),
          created_at: delivery.created_at.toISOString(),
          failedAt: delivery.updated_at.toISOString(),
          // From the failure to the request that caused it (OBS-06).
          eventId: delivery.outboxEventId,
          correlationId: delivery.correlationId,
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    },
  );

  /**
   * Outbox events that exhausted their retries — the other half of the dead
   * letter (OUTBOX-15).
   *
   * An event that never fanned out has no delivery rows, so it never appears
   * in /health/dead-letter; the metrics showed only a count of them. This
   * lists which ones and why: the FAILED events still in the queue table
   * (30 days) and the copies moved to outbox_event_dead_letter, kept 90
   * days from the failure (plano-escala F5-10, outbox-dead-letter.ts).
   * Failures are few; the live ones come through the (status, availableAt)
   * index and the copies through failedAt. MASTER-only, like the rest: it
   * spans every tenant.
   */
  app.get(
    "/health/dead-letter/events",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Eventos do outbox que falharam (dead letter)",
        description:
          "Lista paginada dos eventos do outbox que esgotaram as tentativas de expansão, da falha mais recente para a mais antiga. Eles nunca geraram envios, por isso /health/dead-letter não os mostra. Junta os dois lugares em que uma falha fica: a fila do outbox, nos primeiros 30 dias (`archived: false`), e o arquivo dos eventos que falharam, até `OUTBOX_FAILED_RETENTION_DAYS` (90) dias depois da falha (`archived: true`). Os dois podem ser reprocessados por POST /health/dead-letter/events/replay; um arquivado já reprocessado sai da lista. Só MASTER: abrange todas as empresas.",
        querystring: healthSchemas.deadLetterEventsQuery,
        response: {
          200: healthResponses.deadLetterEvents,
        },
      },
    },
    async (request, reply) => {
      const { page, pageSize } = request.query as z.infer<
        typeof healthSchemas.deadLetterEventsQuery
      >;

      const { rows, total } = await listFailedEvents(page, pageSize);

      return reply.status(200).send({
        data: rows.map((event) => ({
          id: event.id,
          topic: event.topic,
          businessId: event.businessId,
          attempts: event.attempts,
          lastError: deadLetterError(event.lastError),
          created_at: event.created_at.toISOString(),
          failedAt: event.failedAt.toISOString(),
          archived: event.archived,
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    },
  );

  /**
   * Sends FAILED deliveries again — the manual reprocessing the dead letter
   * had no way to do.
   *
   * A provider outage longer than the retry schedule leaves a pile of FAILED
   * rows whose only defect was timing; before this, the only way back was
   * SQL on production. Explicit ids, never "everything": the operator looks
   * at the list first, and a replay is a decision about specific messages.
   * Only FAILED rows move — a replayed id that meanwhile went anywhere else
   * is left alone, so a double click cannot send twice.
   *
   * E-mail is safe to replay within 24 hours of the first send (the delivery
   * id is Resend's idempotency key). WhatsApp is not: a delivery marked
   * FAILED after an ambiguous timeout may have arrived. A push that did
   * arrive is replaced on the device, not doubled: the delivery id goes as
   * its `tag` to every device and as `collapseId` to iPhones only
   * (push-provider.ts).
   */
  app.post(
    "/health/dead-letter/replay",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Reenvia notificações que falharam",
        description:
          "Devolve os envios FAILED indicados para PENDING, com as tentativas zeradas, e acorda o pipeline. Envios em qualquer outro estado são ignorados. Só MASTER. Reenviar WhatsApp pode duplicar uma mensagem que falhou num timeout ambíguo; o e-mail é deduplicado pelo provedor por 24 horas, e o push leva o id do envio como `tag` em todo aparelho (e como `collapseId` só no iPhone), então a cópia substitui a anterior no aparelho.",
        body: healthSchemas.deadLetterReplayBody,
        response: {
          200: healthResponses.deadLetterReplay,
          400: healthResponses.deadLetterReplayInvalid,
        },
      },
    },
    async (request, reply) => {
      const { deliveryIds } = request.body as z.infer<
        typeof healthSchemas.deadLetterReplayBody
      >;

      const result = await database.notificationDelivery.updateMany({
        where: { id: { in: deliveryIds }, status: "FAILED" },
        data: {
          status: "PENDING",
          attempts: 0,
          availableAt: new Date(),
          leaseExpiresAt: null,
          lastError: `Reenfileirada manualmente em ${new Date().toISOString()} por ${request.user.id}`,
        },
      });

      NotificationPipelineService.getInstance().wake();

      return reply.status(200).send({ requeued: result.count });
    },
  );

  /**
   * Expands FAILED outbox events again — the other half of the dead letter,
   * which until now only had a listing (OUTBOX-15). An event that ran out of
   * expansions (a database outage longer than the retry schedule, a policy
   * bug fixed since) had no way back but SQL on production.
   *
   * Safe to repeat: the expansion is idempotent — createMany skipDuplicates
   * over the (event, user, channel) and (event, external recipient, channel)
   * unique keys, and a fenced PUBLISHED mark — so a replayed event creates
   * only the deliveries it never created, and an event that went anywhere
   * but FAILED in the meantime is not touched (a double click moves nothing
   * twice). The deliveries it does create are ordinary rows: each keeps its
   * own channel's dedupe (Resend key, delivery-id unique, push tag).
   *
   * Explicit ids, MASTER only, rate limited like the delivery replay. The
   * durable audit trail is the warn log line below — who, which ids, how
   * many moved. The row's lastError says who and when only until the next
   * expansion, which overwrites it on a failure and clears it on PUBLISHED.
   */
  app.post(
    "/health/dead-letter/events/replay",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["health"],
        summary: "Reprocessa eventos do outbox que falharam",
        description:
          "Reprocessa os eventos que falharam indicados (de GET /health/dead-letter/events) e acorda o pipeline para expandi-los de novo. Um evento ainda na fila (`archived: false`) volta para PENDING com as tentativas zeradas, e a expansão idempotente só cria os envios que ele ainda não tinha criado. Um evento arquivado (`archived: true`, guardado até 90 dias depois da falha) vira um evento NOVO, com id e chave próprios e o mesmo tópico, empresa, autor e conteúdo; o arquivado guarda qual evento ele virou e sai da lista. Ids em qualquer outro estado (um evento que já saiu de FAILED, um arquivado já reprocessado, um id desconhecido) são ignorados, então repetir o pedido não reprocessa nada duas vezes. `requeued` conta os dois casos. Até 100 ids por pedido e 10 pedidos por minuto por usuário. O registro durável de quem pediu é a linha de log de aviso `failed outbox events requeued by hand` (usuário, ids, quantos voltaram e o evento novo de cada arquivado); o `lastError` do evento mostra quem e quando só até a próxima expansão, que o substitui numa falha e o limpa quando o evento é publicado. Só MASTER: abrange todas as empresas.",
        body: healthSchemas.deadLetterEventsReplayBody,
        response: {
          200: healthResponses.deadLetterEventsReplay,
          400: healthResponses.deadLetterEventsReplayInvalid,
        },
      },
    },
    async (request, reply) => {
      const { eventIds } = request.body as z.infer<
        typeof healthSchemas.deadLetterEventsReplayBody
      >;

      const result = await replayFailedEvents(eventIds, request.user.id);
      const requeued = result.requeued + result.recreated.length;

      request.log.warn(
        {
          userId: request.user.id,
          eventIds,
          requeued,
          recreated: result.recreated,
        },
        "failed outbox events requeued by hand",
      );

      NotificationPipelineService.getInstance().wake();

      return reply.status(200).send({ requeued });
    },
  );
}

export { healthRoutes };
