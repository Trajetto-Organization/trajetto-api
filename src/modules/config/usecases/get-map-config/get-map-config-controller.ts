import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetMapConfigUseCase } from "./get-map-config-usecase";

/**
 * Private: the URL may carry the provider's key, so no shared cache keeps
 * it. Five minutes: the value only changes with a deploy, and the app reads
 * it once per map it opens, so a short window costs nothing and lets a fixed
 * provider reach the phones quickly.
 */
const MAP_CONFIG_CACHE_CONTROL = "private, max-age=300";

class GetMapConfigController {
  async handle(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const getMapConfig = container.resolve(GetMapConfigUseCase);

    reply.header("Cache-Control", MAP_CONFIG_CACHE_CONTROL);

    return reply.status(200).send(getMapConfig.execute());
  }
}

export { GetMapConfigController, MAP_CONFIG_CACHE_CONTROL };
