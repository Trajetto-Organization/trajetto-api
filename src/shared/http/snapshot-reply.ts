import type { FastifyReply, FastifyRequest } from "fastify";

import {
  ifNoneMatchHits,
  type TenantSnapshotRead,
} from "@/shared/cache/tenant-snapshot";

/**
 * The HTTP side of a tenant snapshot (plano-escala F4-11): the ETag, the
 * 304, the age of the copy and the refresh hint.
 */

/**
 * The request header that asks for a read newer than the copy: the panel
 * sends `1` when an event, not its timer, makes it refetch (F4-12). The
 * snapshot honours it only once the copy is old enough (minRefreshMs).
 */
const SNAPSHOT_REFRESH_HEADER = "x-trajetto-refresh";

/**
 * A copy is the company's, not the public's: no shared cache stores it
 * (`private`), and a client that keeps it asks again every time, with
 * If-None-Match (`no-cache`), which is what the 304 answers.
 */
const SNAPSHOT_CACHE_CONTROL = "private, no-cache";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function wantsFreshSnapshot(request: FastifyRequest): boolean {
  return request.headers[SNAPSHOT_REFRESH_HEADER] === "1";
}

/**
 * The route's own serializer for a 200: what reply.send would write for the
 * value (src/shared/http/response-serializer.ts parses it by the response
 * schema), so a body kept in a snapshot is byte for byte the answer the
 * route gives without it. Taken once, before the read, and pure: a
 * computation another request joins runs it outside this one.
 */
function successBodyOf(
  reply: FastifyReply,
): (payload: Record<string, unknown>) => string {
  const serialize = reply.getSerializationFunction("200");

  return (payload) =>
    serialize ? serialize(payload) : JSON.stringify(payload);
}

/** Whole seconds since the data was read, as the Age header counts them. */
function ageOf(read: TenantSnapshotRead, now = Date.now()): number {
  return Math.max(0, Math.floor((now - read.at) / 1000));
}

/**
 * Sends what the snapshot read: the body as it was serialized, with its
 * ETag and its age, or a 304 without a body when the client already holds
 * it. A read made with the snapshot off (`off`) leaves without validators,
 * as the answer did before the snapshot.
 */
function sendSnapshot(
  request: FastifyRequest,
  reply: FastifyReply,
  read: TenantSnapshotRead,
): FastifyReply {
  if (read.source !== "off") {
    reply
      .header("etag", read.etag)
      .header("age", String(ageOf(read)))
      .header("cache-control", SNAPSHOT_CACHE_CONTROL);

    if (ifNoneMatchHits(request.headers["if-none-match"], read.etag)) {
      return reply.status(304).send();
    }
  }

  return reply.status(200).type(JSON_CONTENT_TYPE).send(read.body);
}

export {
  SNAPSHOT_CACHE_CONTROL,
  SNAPSHOT_REFRESH_HEADER,
  ageOf,
  sendSnapshot,
  successBodyOf,
  wantsFreshSnapshot,
};
