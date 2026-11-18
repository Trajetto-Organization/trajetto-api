import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import type { IBackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { wakeJobsAfterCommit } from "@/shared/jobs/job-wake";
import { NotificationService } from "@/shared/services/notification-service";

import { totalOpenRoutes } from "../../driver-rules";
import { DriverAlreadyAnonymizedError } from "../errors/driver-already-anonymized-error";
import { DriverHasOpenRoutesError } from "../errors/driver-has-open-routes-error";
import { DriverNotFoundError } from "../errors/driver-not-found-error";

interface AnonymizeDriverRequest {
  driverId: string;
  businessId: string;

  /** Who asks. */
  userId: string;
}

interface AnonymizeDriverResult {
  jobId: string;
}

/**
 * Removes and anonymizes a driver who worked (plano-escala F3-27, decision
 * D49): the delete refuses a driver with history (driverHistoryRefusal),
 * and a person who leaves still has the right to have their data removed.
 * The USER_ANONYMIZE job takes the personal data (the driver's and the app
 * login's), the devices and the hot trail, and keeps the deliveries, proofs
 * and messages under "Motorista removido".
 *
 * Refused while a route still needs the driver (the revocation's rule): the
 * route would wait for someone who no longer exists. A driver of another
 * company is 404, like one that does not exist. Asking twice answers the
 * same job (one live job per driver).
 */
@injectable()
class AnonymizeDriverUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("BackgroundJobRepository")
    private jobs: IBackgroundJobRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    driverId,
    businessId,
    userId,
  }: AnonymizeDriverRequest): Promise<AnonymizeDriverResult> {
    const caller = await this.user.findUserById(userId);

    if (!caller) throw new ResourceNotFoundError();

    assertTenantAccess(caller, businessId);

    const driver = await this.driver.findDriverById(driverId);

    if (!driver || driver.businessId !== businessId) {
      throw new DriverNotFoundError();
    }

    if (driver.anonymized_at) throw new DriverAlreadyAnonymizedError();

    const openRoutes = await this.driver.countOpenRoutes(driverId);

    if (totalOpenRoutes(openRoutes) > 0) {
      throw new DriverHasOpenRoutesError(openRoutes, "ANONYMIZE_DRIVER");
    }

    const job = await database.$transaction(async (tx) => {
      const enqueued = await this.jobs.enqueue(
        {
          kind: "USER_ANONYMIZE",
          businessId,
          subjectId: driverId,
          payload: {
            subject: "driver",
            subjectId: driverId,
            businessId,
            requestedById: userId,
          },
        },
        tx,
      );

      if (enqueued.outcome === "enqueued") {
        await this.notificationService.createActivityIfEnabled(
          {
            type: "Motorista",
            action: "update",
            entityId: driverId,
            description: `Remoção e anonimização do motorista ${driver.name} pedida por ${caller.name}`,
            status: "Anonimização pedida",
            performedBy: userId,
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

export { AnonymizeDriverUseCase };
export type { AnonymizeDriverRequest, AnonymizeDriverResult };
