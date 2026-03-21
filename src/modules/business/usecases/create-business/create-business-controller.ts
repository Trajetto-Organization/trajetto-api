import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateBusinessUseCase } from "./create-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { createBusinessSchema } from "@/schemas/create-business-schema";

import { BusinessEmailAlreadyExistsError } from "../errors/business-email-already-exists-error";
import { BusinessErpCodeAlreadyExistsError } from "../errors/business-erp-code-already-exists-error";

import { BusinessCorporateReasonAlreadyExistsError } from "../errors/business-corporate-reason-already-exists-error";
import { BusinessCnpjAlreadyExistsError } from "../errors/business-cnpj-already-exists-error";

import { BranchNameAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-name-already-exists-error";
import { BranchCnpjAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-cnpj-already-exists-error";

import { BranchErpCodeAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-erp-code-already-exists-error";
import { BranchEmailAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-email-already-exists-error";

class CreateBusinessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const businessData = createBusinessSchema.parse(request.body);
    const createUserUseCase = container.resolve(CreateBusinessUseCase);

    try {
      await createUserUseCase.execute(businessData, id);
      return reply
        .status(201)
        .send({ message: "Empresa e filial matriz criadas com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessCnpjAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessCorporateReasonAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessErpCodeAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessEmailAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNameAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchCnpjAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchErpCodeAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchEmailAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateBusinessController };
