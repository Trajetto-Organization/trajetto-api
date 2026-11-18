import type { FastifyReply, FastifyRequest } from "fastify";

import type { HttpSurface } from "@/shared/lifecycle/process-role";

/**
 * The routes a process answers, by its role (plano-escala F3-01; the
 * security review of the plan).
 *
 * Every role keeps the listener on :3333 with /health*: the image's
 * HEALTHCHECK calls /health/liveness, and the deploy's checks read
 * /health/rollout. A worker, a scheduler or a worker-external has no Domain,
 * but it sits on the dokploy-network with every other environment's
 * containers: serving the whole API there would put a second, unwatched
 * door to every route (and to its rate limits, which count per address) one
 * hostname away from a container of another project. So a process answers
 * only what its role is for, and everything else gets the 404 of a route
 * that does not exist — the same handler, the same body and headers — so
 * nothing tells a hidden route from a missing one.
 *
 * Judged by the route the router matched (`routeOptions.url`, the pattern
 * as registered), never by the raw path: an encoded or doubled slash cannot
 * make a route look like /health to this check and like another route to
 * the router.
 */

/** Whether a route, by its registered pattern, is on the surface. */
function servesRoute(surface: HttpSurface, routeUrl: string | undefined) {
  if (surface === "all") return true;

  // Not a route at all: the router's own 404 answers it, as anywhere.
  if (routeUrl === undefined) return true;

  if (routeUrl === "/health" || routeUrl.startsWith("/health/")) return true;

  // The ingest role takes the positions' flushes (POST /route/positions)
  // off the API's event loop, by its own Domain path.
  if (surface === "ingest" && routeUrl === "/route/positions") return true;

  return false;
}

/**
 * The onRequest hook of a role whose surface is not `all`. Registered as the
 * last of the root onRequest hooks, so a hidden route goes through what a
 * missing one does (the request id, the version gate, the shedding) before
 * the 404, and none of the route's own hooks (its rate limit) runs.
 */
function httpSurfaceHook(surface: HttpSurface) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (error?: Error) => void,
  ): void => {
    if (servesRoute(surface, request.routeOptions.url)) {
      done();
      return;
    }

    reply.callNotFound();
  };
}

export { httpSurfaceHook, servesRoute };
