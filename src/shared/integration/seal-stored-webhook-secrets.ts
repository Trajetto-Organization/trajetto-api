import type { Prisma, PrismaClient } from "@prisma/client";

import {
  areHeadersSealed,
  isSealed,
  openHeaders,
  sealHeaders,
  sealSecret,
} from "./secret-box";

/** Endpoints read and rewritten per round trip. */
const BATCH_SIZE = 500;

/**
 * Seals every webhook credential still stored in clear.
 *
 * For the rows written before WEBHOOK_SECRETS_KEY was configured (in
 * production, sealing is on only once the key is set; everything written
 * before stays readable, in clear). Idempotent: a sealed value is left alone,
 * so running it twice, or after a partial run, is safe. Walks by id, so a
 * large table is never read at once.
 *
 * Each endpoint is rewritten only where its stored value is still the one
 * read — an endpoint edited or rotated in between keeps the newer value.
 */
async function sealStoredWebhookSecrets(
  database: PrismaClient,
  key: Buffer,
): Promise<{ scanned: number; sealed: number }> {
  let cursor: string | undefined;
  let scanned = 0;
  let sealed = 0;

  for (;;) {
    const endpoints = await database.webhookEndpoint.findMany({
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      select: {
        id: true,
        secret: true,
        previous_secret: true,
        headers: true,
      },
    });

    if (endpoints.length === 0) break;

    cursor = endpoints[endpoints.length - 1].id;
    scanned += endpoints.length;

    for (const endpoint of endpoints) {
      const secretPlain = !isSealed(endpoint.secret);
      const previousPlain =
        endpoint.previous_secret !== null &&
        !isSealed(endpoint.previous_secret);
      const headersPlain = !areHeadersSealed(endpoint.headers);

      if (!secretPlain && !previousPlain && !headersPlain) continue;

      const { count } = await database.webhookEndpoint.updateMany({
        where: {
          id: endpoint.id,
          secret: endpoint.secret,
          previous_secret: endpoint.previous_secret,
          ...(headersPlain && {
            headers: { equals: endpoint.headers as Prisma.InputJsonValue },
          }),
        },
        data: {
          ...(secretPlain && { secret: sealSecret(endpoint.secret, key) }),
          ...(previousPlain && {
            previous_secret: sealSecret(endpoint.previous_secret!, key),
          }),
          ...(headersPlain && {
            headers: sealHeaders(openHeaders(endpoint.headers, key), key)!,
          }),
        },
      });

      sealed += count;
    }
  }

  return { scanned, sealed };
}

export { sealStoredWebhookSecrets };
