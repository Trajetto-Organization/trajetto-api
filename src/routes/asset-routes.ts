import { FastifyInstance } from "fastify";

import {
  TRAJETTO_WATERMARK_PNG,
  TRAJETTO_WATERMARK_SHA256,
} from "@/shared/services/proof-assets.generated";

/**
 * Static files the API serves itself. Today: only the logo the e-mails show.
 *
 * One explicit route, not a static root: nothing next to it is reachable by
 * guessing a path, and there is no directory listing. The bytes come from the
 * bundle (assets/proof/trajetto-logo.png, embedded by
 * scripts/generate-proof-assets.ts for the receipt), so the production image
 * needs no assets/ directory and the two copies cannot drift.
 *
 * Public on purpose: a mail client fetches it with no session.
 */
const LOGO_ETAG = `"${TRAJETTO_WATERMARK_SHA256.slice(0, 32)}"`;

// Thirty days. Mail clients and image proxies (Gmail's) cache by URL; the
// ETag lets them revalidate cheaply after that, and a new logo reaches them
// within the window.
const LOGO_CACHE_CONTROL = "public, max-age=2592000";

async function assetRoutes(app: FastifyInstance) {
  app.get(
    "/trajetto-logo.png",
    {
      schema: { hide: true },
    },
    async (request, reply) => {
      reply
        .header("Cache-Control", LOGO_CACHE_CONTROL)
        .header("ETag", LOGO_ETAG)
        // Embedded in a page of another origin (the webmail): the same value
        // helmet sets globally, stated here so the route does not depend on it.
        .header("Cross-Origin-Resource-Policy", "cross-origin");

      if (request.headers["if-none-match"] === LOGO_ETAG) {
        return reply.status(304).send();
      }

      return reply.type("image/png").status(200).send(TRAJETTO_WATERMARK_PNG);
    },
  );
}

export { assetRoutes };
