import type { FastifyRequest } from "fastify";

/**
 * The origin the client used to reach this API.
 *
 * Needed only by the local storage fallback, which hands back a URL the client
 * has to PUT to. A static env var cannot serve both callers in development: the
 * browser reaches the API on `localhost`, while a phone reaches it on the LAN
 * address, and `localhost` on a phone is the phone. Echoing the request's own
 * host is the only answer that is right for whoever asked.
 *
 * Returns undefined when there is no host to read, leaving the caller on its
 * configured default.
 */
function buildPublicBaseUrl(request: FastifyRequest): string | undefined {
  const host = request.headers.host;

  if (!host) return undefined;

  // Behind a proxy the original scheme only survives in this header; Fastify
  // fills `request.protocol` from the socket, which is plain HTTP there.
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(
      ",",
    )[0] || request.protocol;

  return `${protocol}://${host}`;
}

export { buildPublicBaseUrl };
