import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { GenerateHeatmapUseCase } from "./generate-heatmap-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { InvalidHeatmapTypeError } from "../errors/invalid-heatmap-type-error";
import { InvalidDateRangeError } from "../errors/invalid-date-range-error";

import { generateHeatmapSchema } from "@/schemas/generate-heatmap-schema";

class GenerateHeatmapController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const heatmapData = generateHeatmapSchema.parse(request.body);

    const generateHeatmapUseCase = container.resolve(GenerateHeatmapUseCase);

    try {
      const result = await generateHeatmapUseCase.execute(heatmapData, id);

      return reply.status(202).send({
        message: result.message,
        heatmap: result.heatmap,
        status: result.status,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof InvalidHeatmapTypeError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof InvalidDateRangeError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GenerateHeatmapController };
