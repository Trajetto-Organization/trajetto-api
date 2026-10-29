import { FastifyRequest } from "fastify";

import { clientAddress } from "@/config/rate-limit";
import { clientVersionForLog } from "@/shared/http/client-version";

import { urlForLog } from "./redact-url";

/**
 * The `req` of every request log line, with the CLIENT's address.
 *
 * Fastify's default serializer logs `request.ip`, which without `trustProxy`
 * is the socket's peer — behind Cloudflare and Traefik, the same proxy
 * address on every line, so an attack left no trace of where it came from
 * (OBS-13). The address is resolved exactly as the rate limiter resolves it
 * (`clientAddress`: the configured proxy mode, the web server's vouched
 * header), so the log names the address the limiter counted.
 *
 * `trustProxy` is deliberately not turned on instead: it would change
 * `request.ip`, `hostname` and `protocol` for the whole app, and would ignore
 * the header our web server vouches for.
 *
 * Otherwise the same fields as Fastify's default serializer, except `url`:
 * the route pattern, never the raw line, which carries one-time tokens in its
 * query and path (OBS-05, see `urlForLog`).
 */
function requestLogSerializer(request: FastifyRequest) {
  const version = request.headers?.["accept-version"];

  return {
    method: request.method,
    url: urlForLog(request),
    version: Array.isArray(version) ? version[0] : version,
    host: request.host,
    remoteAddress: clientAddress(request),
    remotePort: request.socket?.remotePort,

    // The app build, when it says (GAP5-2). On every line, accepted or not:
    // logged only on refusals, a build still in daily use left no trace, and
    // the logs said nobody was below a MIN_MOBILE_CONTRACT about to lock it out.
    client: clientVersionForLog(request),
  };
}

export { requestLogSerializer };
