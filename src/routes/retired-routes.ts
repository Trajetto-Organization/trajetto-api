import type { FastifyInstance } from "fastify";

import { clientVersionForLog } from "@/shared/http/client-version";

/**
 * Endpoints a release removed, still answered — with 410 — for a while.
 *
 * The web deploys separately from this API and a phone keeps its build until
 * its driver updates it, so for a while after every release something is
 * still calling the URLs that release removed. Left to the not-found handler
 * they get 404 ROUTE_NOT_FOUND, the same answer as a typo: the old settings
 * tab says "Erro inesperado", and the log cannot tell a stale build from a
 * broken link. A tombstone answers 410 ENDPOINT_RETIRED instead: a message
 * the old screen can show as it is, the endpoint that replaced it when there
 * is one, and a log line carrying the caller's build (x-trajetto-client-
 * version) — which is how anyone knows when the tombstone itself can go.
 *
 * The expand/contract rule in the web's deploy runbook: an endpoint leaves
 * src/routes in one release and lands here in the same change. Remove an
 * entry only once the logs have shown no caller for a whole release. Never
 * list something that still exists — Fastify refuses to boot on a duplicate,
 * and retired-routes.test.ts checks every entry against the live router, and
 * the router against what main served where the branch left it.
 *
 * Hidden from the document: nothing new should be written against these.
 * Open without a token on purpose — a 410 carries no data, and an expired
 * session should not stand between an old tab and the reason it failed.
 */
interface RetiredRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

  /** Fastify syntax, exactly as the removed route was registered. */
  url: string;

  /** When it was removed, for whoever deletes the tombstone later. */
  retiredIn: string;

  /** pt-BR, shown as it is by the web and by the app. */
  message: string;

  /** `METHOD /path` of what replaced it, when something did. */
  replacement?: string;

  /** The removed route's own log level, when it had one on purpose. */
  logLevel?: "silent";
}

const RELOAD = "Recarregue a página para continuar.";

const RETIRED_ROUTES: readonly RetiredRoute[] = [
  {
    method: "PATCH",
    url: "/user/email-notifications",
    retiredIn: "2026-09",
    message: `As notificações por e-mail passaram para as preferências de notificação e esta forma de salvá-las foi descontinuada. ${RELOAD}`,
    replacement: "PUT /notification/preferences",
  },
  {
    method: "PATCH",
    url: "/user/activity-notifications",
    retiredIn: "2026-09",
    message: `As notificações de atividade passaram para as preferências de notificação e esta forma de salvá-las foi descontinuada. ${RELOAD}`,
    replacement: "PUT /notification/preferences",
  },
  {
    // Moved under the tenant (cross-tenant fix): the old path took only the
    // fine's id, so it could not be authorised against the caller's business.
    method: "DELETE",
    url: "/fines/delete-fine/:fineId",
    retiredIn: "2026-09",
    message: `Esta forma de excluir multas foi descontinuada. ${RELOAD}`,
    replacement: "DELETE /fines/delete-fine/:fineId/business/:businessId",
  },
  {
    method: "GET",
    url: "/whatsapp/status",
    retiredIn: "2026-09",
    message: `A conexão do WhatsApp por QR code foi descontinuada: as notificações agora usam a API oficial do WhatsApp, sem pareamento. ${RELOAD}`,
    replacement: "GET /whatsapp/settings",
  },
  {
    method: "GET",
    url: "/whatsapp/connect/qrcode",
    retiredIn: "2026-09",
    message: `A conexão do WhatsApp por QR code foi descontinuada: as notificações agora usam a API oficial do WhatsApp, sem pareamento. ${RELOAD}`,
    replacement: "PATCH /whatsapp/settings",
  },
  {
    // The Evolution API instance's callback. Its heartbeats are why the
    // removed route logged nothing; a still-configured instance would
    // otherwise write a line per heartbeat. No replacement: Meta's callback
    // (/webhooks/whatsapp) is a different sender, configured on Meta's side.
    method: "POST",
    url: "/whatsapp/webhook/:instanceName",
    retiredIn: "2026-09",
    message:
      "O webhook de instância do WhatsApp foi descontinuado: as notificações agora usam a API oficial do WhatsApp.",
    logLevel: "silent",
  },
];

async function retiredRoutes(app: FastifyInstance) {
  for (const retired of RETIRED_ROUTES) {
    const id = `${retired.method} ${retired.url}`;

    app.route({
      method: retired.method,
      url: retired.url,
      schema: { hide: true },
      ...(retired.logLevel ? { logLevel: retired.logLevel } : {}),
      handler: async (request, reply) => {
        request.log.info(
          { client: clientVersionForLog(request), retired: id },
          "Retired endpoint called",
        );

        // Same keys as the 404 body (statusCode, error, message, code), so a
        // client that parses one parses the other.
        return reply
          .status(410)
          .header("x-error-code", "ENDPOINT_RETIRED")
          .send({
            statusCode: 410,
            error: "Gone",
            code: "ENDPOINT_RETIRED",
            message: retired.message,
            ...(retired.replacement ? { replacement: retired.replacement } : {}),
          });
      },
    });
  }
}

export { RETIRED_ROUTES, retiredRoutes };
export type { RetiredRoute };
