import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListTrafficViolationCodeUseCase } from "./list-traffic-violation-code-usecase";
import { listTrafficViolationCodeSchema } from "@/schemas/list-traffic-violation-code-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListTrafficViolationCodeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { page, pageSize, search, gravity, violatorType } =
      listTrafficViolationCodeSchema.parse(request.query);

    const listTrafficViolationCodeUseCase = container.resolve(
      ListTrafficViolationCodeUseCase,
    );

    // Secure handling for URL decoding
    let decodedSearch: string | undefined = undefined;
    if (search) {
      try {
        decodedSearch = decodeURIComponent(search);
      } catch (error) {
        decodedSearch = search;
      }
    }

    const trafficViolationCodesPromise =
      listTrafficViolationCodeUseCase.execute(
        id,
        page,
        pageSize,
        decodedSearch,
        gravity,
        violatorType,
      );

    await sendAsNDJSON({
      reply,
      dataPromise: trafficViolationCodesPromise,
      page,
      pageSize,
    });
  }
}

export { ListTrafficViolationCodeController };
