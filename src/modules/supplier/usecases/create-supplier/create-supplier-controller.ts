import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { CreateSupplierUseCase } from "./create-supplier-usecase";
import { createSupplierSchema } from "@/schemas/create-supplier-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateSupplierController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const supplierData = createSupplierSchema.parse(request.body);
    const createSupplierUseCase = container.resolve(CreateSupplierUseCase);

    // Conflicts (409 SUPPLIER_*_TAKEN) are AppErrors: the error handler
    // answers them with their code, which the web shows verbatim.
    const created = await createSupplierUseCase.execute(
      { ...supplierData, businessId },
      id,
    );

    return reply
      .status(201)
      .send({ message: "Fornecedor criado com sucesso!", id: created.id });
  }
}

export { CreateSupplierController };
