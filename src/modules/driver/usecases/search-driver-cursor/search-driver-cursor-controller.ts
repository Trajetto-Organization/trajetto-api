import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { container } from "tsyringe";

import { SearchDriverCursorUseCase } from "./search-driver-cursor-usecase";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { sendAsNDJSON } from "@/config/stream-utils";
import type { PermissionPrincipal } from "@/modules/middlewares/verify-permission";

import { driverPickerAccess } from "./driver-picker-access";

class SearchDriverCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    // Validated and transformed by the route (limit is a number already).
    const { limit, cursor, businessId, search } = request.query as z.infer<
      typeof cursorPaginationByBusinessSchema
    >;

    const searchDriverCursorUseCase = container.resolve(
      SearchDriverCursorUseCase,
    );

    // The route's guard let the caller in by one of two keys; which one
    // decides how much of each driver they see (decision 4.7).
    const projection =
      driverPickerAccess(request.user as PermissionPrincipal) ?? "choice";

    const dataPromise = searchDriverCursorUseCase.execute({
      userId: id,
      limit,
      cursor,
      businessId,
      search,
      projection,
    });

    // A MASTER naming a company that does not exist is a 404 with its code
    // (decision 11.3), raised before the stream opens.
    return await sendAsNDJSON({
      reply,
      dataPromise: dataPromise.then((result) => ({
        data: result.data,
        total: 0,
        meta: {
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        },
      })),
    });
  }
}

export { SearchDriverCursorController };
