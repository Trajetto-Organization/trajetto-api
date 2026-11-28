import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";
import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { permissionDenied } from "@/shared/errors/access-errors";
import type { IBackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { wakeJobsAfterCommit } from "@/shared/jobs/job-wake";
import { NotificationService } from "@/shared/services/notification-service";

import type { UserRole } from "../../dtos/user-dto";
import {
  UserAlreadyAnonymizedError,
  UserIsDriverLoginError,
} from "../errors/user-anonymize-errors";
import { UserCannotBeDeletedByHimselfError } from "../errors/user-cannot-be-deleted-by-himself-error";

interface AnonymizeUserRequest {
  /** The login to remove. */
  userId: string;

  /** Who asks. */
  callerId: string;
}

/**
 * Removes and anonymizes a panel login that has records (plano-escala
 * F3-27, decision D49): the delete refuses it (USER_HAS_RECORDS) and the
 * revocation keeps the person's data. The USER_ANONYMIZE job takes the
 * name, e-mail, phone, photo, sessions and devices, and keeps what the
 * person wrote under "Usuário removido".
 *
 * The delete's rules of who may remove whom: never oneself, never a MASTER,
 * never a level above the caller's, never another company's (404). A
 * driver's login goes with its driver (409 USER_IS_DRIVER_LOGIN). Asking
 * twice answers the same job.
 */
@injectable()
class AnonymizeUserUseCase {
  private allowed: Record<UserRole, UserRole[]> = {
    BUSINESS_USER: ["BUSINESS_USER"],
    BUSINESS_ADMIN: ["BUSINESS_USER", "BUSINESS_ADMIN"],
    MASTER: ["BUSINESS_USER", "BUSINESS_ADMIN"],
  };

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BackgroundJobRepository")
    private jobs: IBackgroundJobRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    callerId,
  }: AnonymizeUserRequest): Promise<{ jobId: string }> {
    const caller = await this.user.findUserById(callerId);

    if (!caller) throw new ResourceNotFoundError();

    if (caller.id === userId) throw new UserCannotBeDeletedByHimselfError();

    const target = await this.user.findUserById(userId);

    if (!target || !target.businessId) throw new ResourceNotFoundError();

    assertTenantAccessToRecord(
      caller,
      target.businessId,
      () => new ResourceNotFoundError(),
    );

    if (
      target.role === "MASTER" ||
      !this.allowed[caller.role].includes(target.role)
    ) {
      throw permissionDenied(
        "Você não pode remover um usuário com nível de acesso acima do seu.",
      );
    }

    if (target.driverId) throw new UserIsDriverLoginError();

    if (target.anonymized_at) throw new UserAlreadyAnonymizedError();

    const businessId = target.businessId;

    const job = await database.$transaction(async (tx) => {
      const enqueued = await this.jobs.enqueue(
        {
          kind: "USER_ANONYMIZE",
          businessId,
          subjectId: userId,
          payload: {
            subject: "user",
            subjectId: userId,
            businessId,
            requestedById: callerId,
          },
        },
        tx,
      );

      if (enqueued.outcome === "enqueued") {
        await this.notificationService.createActivityIfEnabled(
          {
            type: "Usuário",
            action: "update",
            entityId: userId,
            description: `Remoção e anonimização do usuário ${target.name} pedida por ${caller.name}`,
            status: "Anonimização pedida",
            performedBy: callerId,
            businessId,
          },
          tx,
        );
      }

      return enqueued.job;
    });

    wakeJobsAfterCommit();

    return { jobId: job.id };
  }
}

export { AnonymizeUserUseCase };
export type { AnonymizeUserRequest };
