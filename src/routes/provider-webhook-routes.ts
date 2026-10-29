import { FastifyInstance } from "fastify";

import { env } from "@/env";
import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";

import { logger } from "@/shared/logging/logger";
import {
  logTemplateUpdates,
  recordMetaStatuses,
} from "@/shared/notifications/provider-receipts";
import {
  extractMetaStatuses,
  extractMetaTemplateUpdates,
  isMetaVerifyTokenValid,
  verifyMetaSignature,
} from "@/shared/providers/whatsapp-provider/meta-webhook";
import {
  applyWhatsAppTemplateLaneChange,
  templateLaneChanges,
} from "@/shared/providers/whatsapp-provider/template-lane";
import { broadcastWhatsAppTemplateLaneChange } from "@/websocket";
import { recordResendEvent } from "@/shared/notifications/resend-receipts";
import {
  extractResendEvent,
  verifySvixSignature,
} from "@/shared/providers/mail-provider/resend-webhook";

const log = logger.child({ component: "provider-webhooks" });

/**
 * Meta batches up to 1000 statuses per callback; a few hundred bytes each.
 * A megabyte is generous for that and still refuses a body that is not one.
 */
const WEBHOOK_BODY_LIMIT = 1_048_576;

/** What Meta sends as hub.challenge: digits. Echoed back, so kept narrow. */
const CHALLENGE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Callbacks FROM providers, about messages we sent (OUTBOX-07, OBS-08).
 *
 * No session and no API key: the caller is the provider, and what proves it
 * is the provider's own signature over the body, checked before anything is
 * read. Unconfigured, each route is a 404 — it does not exist until the
 * secret that authenticates it does.
 *
 * Hidden from the OpenAPI document: nobody but the provider calls these, and
 * the contract is the provider's, not ours.
 *
 * The one place a provider's receiver belongs: Meta's status callbacks and
 * Resend's delivery/bounce/complaint events (Svix-signed) both live here.
 */
async function providerWebhookRoutes(app: FastifyInstance) {
  // The signature is over the RAW bytes. The application's JSON parser would
  // hand the handler an object, and re-serialising it never reproduces the
  // bytes Meta signed. Scoped to this plugin: every other route keeps the
  // hardened parser (see http.ts).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.get(
    "/whatsapp",
    {
      config: { rateLimit: getRateLimiterConfig({ max: 30 }) },
      schema: { hide: true },
    },
    async (request, reply) => {
      const expected = env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN;

      if (!expected) return reply.callNotFound();

      const query = request.query as Record<string, string | undefined>;
      const challenge = query["hub.challenge"];

      if (
        query["hub.mode"] !== "subscribe" ||
        !isMetaVerifyTokenValid(query["hub.verify_token"], expected) ||
        !challenge ||
        !CHALLENGE.test(challenge)
      ) {
        return reply
          .status(403)
          .send({ message: "Verificação do webhook recusada." });
      }

      return reply.type("text/plain").send(challenge);
    },
  );

  app.post(
    "/whatsapp",
    {
      // Meta delivers in bursts after a large send; the limit only has to
      // stop somebody else hammering a route that verifies an HMAC per call.
      config: { rateLimit: getRateLimiterConfig({ max: 600 }) },
      schema: { hide: true },
    },
    async (request, reply) => {
      const secret = env.META_WHATSAPP_APP_SECRET;

      if (!secret) return reply.callNotFound();

      const raw = Buffer.isBuffer(request.body) ? request.body : null;

      const signature = request.headers["x-hub-signature-256"];

      if (
        !raw ||
        !verifyMetaSignature(
          raw,
          typeof signature === "string" ? signature : undefined,
          secret,
        )
      ) {
        return reply
          .status(401)
          .send({ message: "Assinatura do webhook inválida." });
      }

      let body: unknown;

      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        // Signed by Meta and still not JSON: nothing a retry will change.
        log.warn("meta webhook body is signed but is not JSON");
        return reply.status(200).send({ received: true });
      }

      const templateUpdates = extractMetaTemplateUpdates(body);

      logTemplateUpdates(templateUpdates);

      // Meta paused (or reinstated) a template: the lane stops before a send
      // is refused, here and on every other replica (OUTBOX-07 d, OUTBOX-16).
      // Idempotent, so a callback Meta repeats after a 5xx below is harmless.
      for (const change of templateLaneChanges(templateUpdates)) {
        applyWhatsAppTemplateLaneChange(change);
        broadcastWhatsAppTemplateLaneChange(change);
      }

      // A database failure propagates: the 5xx makes Meta deliver the
      // callback again, and the ledger's unique key absorbs the repeat.
      await recordMetaStatuses(extractMetaStatuses(body));

      return reply.status(200).send({ received: true });
    },
  );

  /**
   * Resend's word on an e-mail after it accepted it (OBS-08): delivered,
   * delayed, bounced, complained. Until this existed an e-mail that bounced
   * stayed DELIVERED for good. One event per call.
   */
  app.post(
    "/resend",
    {
      config: { rateLimit: getRateLimiterConfig({ max: 600 }) },
      schema: { hide: true },
    },
    async (request, reply) => {
      const secret = env.RESEND_WEBHOOK_SECRET;

      if (!secret) return reply.callNotFound();

      const raw = Buffer.isBuffer(request.body) ? request.body : null;
      const header = (name: string) => {
        const value = request.headers[name];
        return typeof value === "string" ? value : undefined;
      };

      if (
        !raw ||
        !verifySvixSignature(
          {
            id: header("svix-id"),
            timestamp: header("svix-timestamp"),
            signature: header("svix-signature"),
          },
          raw,
          secret,
        )
      ) {
        return reply
          .status(401)
          .send({ message: "Assinatura do webhook inválida." });
      }

      let body: unknown;

      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        log.warn("resend webhook body is signed but is not JSON");
        return reply.status(200).send({ received: true });
      }

      const report = extractResendEvent(body);

      // Opens, clicks, domain and contact events: acknowledged, not kept.
      if (report) {
        // A database failure propagates: the 5xx makes Svix deliver the
        // event again, and the ledger's unique key absorbs the repeat.
        await recordResendEvent(report);
      }

      return reply.status(200).send({ received: true });
    },
  );
}

export { providerWebhookRoutes };
