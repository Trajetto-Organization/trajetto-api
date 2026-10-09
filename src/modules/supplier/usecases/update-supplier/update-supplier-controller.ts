import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { UpdateSupplierUseCase } from "./update-supplier-usecase";
import { updateDeleteSupplierSchema } from "@/schemas/update-delete-supplier-schema";
import { updateSupplierSchema } from "@/schemas/update-supplier-schema";

class UpdateSupplierController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { supplierId, businessId } = updateDeleteSupplierSchema.parse(
      request.params,
    );

    const supplierData = updateSupplierSchema.parse(request.body);
    const updateSupplierUseCase = container.resolve(UpdateSupplierUseCase);

    // 404 SUPPLIER_NOT_FOUND, 403 SUPPLIER_TENANT_MISMATCH and the 409
    // conflicts are AppErrors, answered with their code by the error handler.
    await updateSupplierUseCase.execute(
      supplierData,
      supplierId,
      businessId,
      id,
    );

    return reply
      .status(200)
      .send({ message: "Fornecedor atualizado com sucesso!" });
  }
}

export { UpdateSupplierController };
