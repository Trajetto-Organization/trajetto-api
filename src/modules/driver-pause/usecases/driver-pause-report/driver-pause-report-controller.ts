import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { DriverPauseReportUseCase } from "./driver-pause-report-usecase";

import { businessParam, reportQuery } from "../../schemas/driver-pause-schemas";

class DriverPauseReportController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { businessId } = businessParam.parse(request.params);

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it against the wire schema
    // would reject it.
    const { from, to, driverId, flag, page, pageSize } =
      request.query as z.infer<typeof reportQuery>;

    const useCase = container.resolve(DriverPauseReportUseCase);

    const report = await useCase.execute({
      businessId,
      from,
      to,
      driverIds: driverId,
      flags: flag,
      page: page ?? 1,
      pageSize: pageSize ?? 10,
    });

    return reply.status(200).send(report);
  }
}

export { DriverPauseReportController };
