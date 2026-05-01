import { inject, injectable } from "tsyringe";

import crypto from "node:crypto";
import { hash } from "bcrypt";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IPendingDeletionProvider } from "@/shared/providers/pending-deletion-provider/IPendingDeletion-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BusinessHasChildrenError } from "@/modules/business/usecases/errors/business-has-children-error";

import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";
import { AppError } from "@/shared/errors/AppError";

import { env } from "@/env";

const CODE_EXPIRATION_MINUTES = 5;

@injectable()
class RequestBusinessDeletionUseCase {
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;
  private emailQueue: EmailWorkerAdapter;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("PendingDeletionProvider")
    private pendingDeletion: IPendingDeletionProvider,
  ) {
    this.emailQueue = new EmailWorkerAdapter(
      "requestBusinessDeletionEmailQueue",
    );
  }

  async execute(
    businessId: string,
    userId: string,
  ): Promise<{ message: string }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const existingBusiness = await this.business.findBusinessById(businessId);

    if (!existingBusiness) {
      throw new BusinessNotFoundError();
    }

    // Fail fast: don't bother sending code if business can't be deleted anyway
    const dependencies =
      await this.business.countBusinessDependencies(businessId);

    const details: string[] = [];

    if (dependencies.branches > 0) {
      details.push(`${dependencies.branches} filial(is) vinculada(s)`);
    }

    if (dependencies.users > 0) {
      details.push(`${dependencies.users} usuário(s) vinculado(s)`);
    }

    if (dependencies.drivers > 0) {
      details.push(`${dependencies.drivers} motorista(s) vinculado(s)`);
    }

    if (details.length > 0) {
      throw new BusinessHasChildrenError(`Existem ${details.join(", ")}.`);
    }

    const code = crypto.randomInt(100_000, 1_000_000).toString();

    const codeHash = await hash(code, 10);
    const expires = new Date(Date.now() + CODE_EXPIRATION_MINUTES * 60 * 1000);

    try {
      await this.pendingDeletion.upsertPendingDeletion({
        entity_type: "business",
        entity_id: businessId,
        userId: findUser.id,
        code_hash: codeHash,
        expires,
      });

      await this.emailQueue.enqueueEmail({
        email: findUser.email,
        name: findUser.name,
        subject: "Código de confirmação para exclusão de empresa",
        templateName: "business-deletion-code.hbs",
        moduleName: "business",
        additionalVariablesProperties: {
          code,
          businessName: existingBusiness.corporate_reason,
          businessCnpj: existingBusiness.cnpj,
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

export { RequestBusinessDeletionUseCase };
