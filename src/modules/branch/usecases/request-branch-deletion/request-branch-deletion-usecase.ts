import { inject, injectable } from "tsyringe";

import crypto from "node:crypto";
import { hash } from "bcrypt";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IPendingDeletionProvider } from "@/shared/providers/pending-deletion-provider/IPendingDeletion-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "../errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "../errors/branch-not-belong-business-error";

import { BranchHasChildrenError } from "../errors/branch-has-children-error";

import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";
import { AppError } from "@/shared/errors/AppError";

import { env } from "@/env";

const dependencyLabels: Record<string, string> = {
  vehicles: "veículo(s)",
  drivers: "motorista(s)",
  serviceOrders: "ordem(ns) de serviço",
  accountsPayable: "conta(s) a pagar",
  fines: "multa(s)",
  fuels: "abastecimento(s)",
  vehicleChecklists: "checklist(s) de veículo",
};

const CODE_EXPIRATION_MINUTES = 5;

@injectable()
class RequestBranchDeletionUseCase {
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;
  private emailQueue: EmailWorkerAdapter;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("PendingDeletionProvider")
    private pendingDeletion: IPendingDeletionProvider,
  ) {
    this.emailQueue = new EmailWorkerAdapter("requestBranchDeletionEmailQueue");
  }

  async execute(
    branchId: string,
    businessId: string,
    userId: string,
  ): Promise<{ message: string }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findBranch = await this.branch.findBranchById(branchId);

    if (!findBranch) {
      throw new BranchNotFoundError();
    }

    if (findBranch.businessId !== businessId) {
      throw new BranchNotBelongBusinessError();
    }

    // Fail fast: don't bother sending code if branch can't be deleted anyway
    const dependencies = await this.branch.countBranchDependencies(branchId);
    const details: string[] = [];

    for (const [key, count] of Object.entries(dependencies)) {
      if (count > 0) {
        const label = dependencyLabels[key] || key;
        details.push(`${count} ${label}`);
      }
    }

    if (details.length > 0) {
      throw new BranchHasChildrenError(`Existem ${details.join(", ")}.`);
    }

    const code = crypto.randomInt(100_000, 1_000_000).toString();
    const codeHash = await hash(code, 10);

    const expires = new Date(Date.now() + CODE_EXPIRATION_MINUTES * 60 * 1000);

    try {
      await this.pendingDeletion.upsertPendingDeletion({
        entity_type: "branch",
        entity_id: branchId,
        userId: findUser.id,
        code_hash: codeHash,
        expires,
      });

      await this.emailQueue.enqueueEmail({
        email: findUser.email,
        name: findUser.name,
        subject: "Código de confirmação para exclusão de filial",
        templateName: "branch-deletion-code.hbs",
        moduleName: "branch",
        additionalVariablesProperties: {
          code,
          branchName: findBranch.corporate_reason,
          branchCnpj: findBranch.cnpj,
          businessName: findBusiness.corporate_reason,
          logo: this.cloudinaryLogo,
        },
      });

      return {
        message:
          "Um código de confirmação foi enviado para o seu e-mail. O código expira em 5 minutos.",
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o código de confirmação! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { RequestBranchDeletionUseCase };
