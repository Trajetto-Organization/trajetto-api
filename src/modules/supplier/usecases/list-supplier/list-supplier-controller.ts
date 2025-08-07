import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { ListSupplierUseCase } from "./list-supplier-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListSupplierController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { page, pageSize, search } = request.query as z.infer<
      typeof listPagesSchema
    >;

    const listSupplierUseCase = container.resolve(ListSupplierUseCase);

    // Secure handling for URL decoding
    let decodedSearch: string | undefined = undefined;
    if (search) {
      try {
        // Try to decode, but catch errors
        decodedSearch = decodeURIComponent(search);
      } catch (error) {
        // If it fails, use the value without decoding.
        decodedSearch = search;
      }
    }

    try {
      const supplierList = listSupplierUseCase.execute(
        id,
        page,
        pageSize,
        decodedSearch,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: supplierList,
        page,
        pageSize,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListSupplierController };
