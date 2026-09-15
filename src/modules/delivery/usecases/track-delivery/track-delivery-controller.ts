import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { TrackDeliveryUseCase } from "./track-delivery-usecase";
import { publicTokenParamsSchema } from "@/schemas/proof-document-schema";

class TrackDeliveryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { token } = publicTokenParamsSchema.parse(request.params);

    const useCase = container.resolve(TrackDeliveryUseCase);

    const data = await useCase.execute({ token });

    // A delivery in motion is the whole point of this page; a cached answer is
    // the one thing it must never give.
    return reply
      .header("Cache-Control", "no-store")
      .status(200)
      .send({ message: "Acompanhamento disponível.", data });
  }
}

export { TrackDeliveryController };
