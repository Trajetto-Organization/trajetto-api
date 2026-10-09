import type { IncomingMessage } from "node:http";

import { v7 as uuidv7 } from "uuid";

/**
 * What a caller's own `x-request-id` must look like to be kept: letters,
 * digits, dashes and underscores, 8 to 64 of them. Anything else — markup,
 * spaces, a line break trying to forge a second log line — is replaced, since
 * the value lands in every log line of the request and in the outbox row.
 */
const WELL_FORMED_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

function inboundRequestId(
  value: string | string[] | undefined,
): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;

  return typeof candidate === "string" && WELL_FORMED_REQUEST_ID.test(candidate)
    ? candidate
    : null;
}

/**
 * The id of a request, for Fastify's `genReqId` (OBS-06).
 *
 * Fastify's default is a per-process counter — `req-1`, `req-2`… — so both
 * replicas, and every restart, handed out the same ids, and none of them ever
 * left the process. A uuid v7 is unique across replicas and restarts and
 * sorts by time, which is how anybody reading logs looks for it.
 *
 * A caller that already has an id for this request (a web server, a retry
 * that should group with its first attempt) sends it as `x-request-id` and it
 * is kept when well-formed. Nothing relies on the id being unique, so a
 * caller choosing its own can only confuse its own lines.
 */
function generateRequestId(request: IncomingMessage): string {
  return inboundRequestId(request.headers["x-request-id"]) ?? uuidv7();
}

export { generateRequestId, inboundRequestId };
