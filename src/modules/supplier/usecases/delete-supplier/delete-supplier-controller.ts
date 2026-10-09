import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { DeleteSupplierUseCase } from "./delete-supplier-usecase";
import { updateDeleteSupplierSchema } from "@/schemas/update-delete-supplier-schema";

class DeleteSupplierController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { supplierId, businessId } = updateDeleteSupplierSchema.parse(
      request.params,
    );

    const deleteSupplierUseCase = container.resolve(DeleteSupplierUseCase);

    // 404 SUPPLIER_NOT_FOUND, 403 SUPPLIER_TENANT_MISMATCH and 409
    // SUPPLIER_IN_USE (with the counts in the message) are AppErrors.
    await deleteSupplierUseCase.execute(supplierId, businessId, id);
    return reply
      .status(200)
      .send({ message: "Fornecedor excluído com sucesso!" });
  }
}

export { DeleteSupplierController };
