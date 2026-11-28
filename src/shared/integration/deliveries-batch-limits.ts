/**
 * The sizes of POST /integration/v1/deliveries/batch (plano-escala U-04),
 * on their own and importing nothing: the public guide
 * (shared/integration/public-docs.ts) says them, and it is in the
 * realtime's import closure (.github/realtime-closure.txt), where the
 * batch's schema and the delivery schemas behind it must not be.
 */

/** Deliveries per call: what one request and its transactions may hold. */
const MAX_BATCH_DELIVERIES = 100;

/**
 * What one delivery of a batch may weigh, on average: 200 items (the
 * single create's own limit) of about 300 bytes each, plus the delivery's
 * own fields, fit in 64 KiB. Fastify's default of 1 MiB, the single
 * create's, refused with an undocumented 413 a batch of a hundred NF-e
 * deliveries of sixty items each.
 */
const BATCH_BODY_BYTES_PER_DELIVERY = 64 * 1024;

/**
 * The batch's body limit: 6.25 MiB. Bounded, because the whole body is
 * held and parsed in memory before a delivery is read, and in line with
 * the spreadsheet import's limit.
 */
const BATCH_BODY_LIMIT_BYTES =
  MAX_BATCH_DELIVERIES * BATCH_BODY_BYTES_PER_DELIVERY;

/** "6,25 MiB": the limit as the 413 and the reference say it. */
const BATCH_BODY_LIMIT_LABEL = `${String(BATCH_BODY_LIMIT_BYTES / (1024 * 1024)).replace(".", ",")} MiB`;

/** The 413 of a body past it, before any of it is read. */
const BATCH_TOO_LARGE = {
  code: "BATCH_TOO_LARGE",
  message: `O corpo do lote passa de ${BATCH_BODY_LIMIT_LABEL}; divida as entregas em lotes menores e envie de novo.`,
} as const;

export {
  BATCH_BODY_LIMIT_BYTES,
  BATCH_BODY_LIMIT_LABEL,
  BATCH_TOO_LARGE,
  MAX_BATCH_DELIVERIES,
};
