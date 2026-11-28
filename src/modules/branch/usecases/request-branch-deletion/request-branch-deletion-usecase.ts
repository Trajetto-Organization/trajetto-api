import { inject, injectable } from "tsyringe";

import crypto from "node:crypto";
import { hashSecret } from "@/shared/security/bcrypt-gate";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IPendingDeletionProvider } from "@/shared/providers/pending-deletion-provider/IPendingDeletion-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "../errors/branch-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { BranchHasChildrenError } from "../errors/branch-has-children-error";
import { BranchHeadOfficeNotDeletableError } from "../errors/branch-head-office-not-deletable-error";
import { isHeadOffice } from "../../branch-head-office";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { AppError } from "@/shared/errors/AppError";

import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";
import { requireMailbox } from "@/modules/user/services/user-mailbox";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "branch" });

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
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("PendingDeletionProvider")
    private pendingDeletion: IPendingDeletionProvider,
  ) {}

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

    assertTenantAccess(findUser, businessId);

    // The code goes to this mailbox: refuse before storing one nobody gets.
    const mailbox = requireMailbox(findUser);

    const findBranch = await this.branch.findBranchById(branchId);

    // Another company's branch answers like a missing one (decision 11.3).
    if (!findBranch || findBranch.businessId !== businessId) {
      throw new BranchNotFoundError();
    }

    // The head office is never deleted (owner decision of 26/11/2026): the
    // company would be left with none, its saves in Empresas mirroring onto
    // nothing, and the next branch created with its CNPJ silently taking the
    // place. Checked after the tenant check above, so another company's
    // head office stays a plain 404, and before any code is stored, mailed
    // or consumed.
    if (isHeadOffice(findBranch, findBusiness)) {
      throw new BranchHeadOfficeNotDeletableError();
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
    const codeHash = await hashSecret(code, 10);

    const expires = new Date(Date.now() + CODE_EXPIRATION_MINUTES * 60 * 1000);

    try {
      await this.pendingDeletion.upsertPendingDeletion({
        entity_type: "branch",
        entity_id: branchId,
        userId: findUser.id,
        code_hash: codeHash,
        expires,
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o código de confirmação! Por favor, tente novamente.",
        500,
      );
    }

    // Sent after the answer, as the company's deletion code is: the code is
    // stored above, asking again replaces it, and it carries a secret, so it
    // stays in-process, off the outbox.
    void sendTransactionalMail({
      email: mailbox,
      name: findUser.name,
      subject: "Código de confirmação para exclusão de filial",
      templateName: "branch-deletion-code.hbs",
      moduleName: "branch",
      additionalVariablesProperties: {
        code,
        branchName: findBranch.corporate_reason,
        branchCnpj: findBranch.cnpj,
        businessName: findBusiness.corporate_reason,
        logo: emailLogoUrl(),
      },
    }).catch((error) =>
      log.error(
        { err: error, userId: findUser.id, branchId },
        "branch deletion code e-mail could not be sent",
      ),
    );

    return {
      message:
        "Um código de confirmação foi enviado para o seu e-mail. O código expira em 5 minutos.",
    };
  }
}

export { RequestBranchDeletionUseCase };
