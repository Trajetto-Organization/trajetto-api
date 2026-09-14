import { inject, injectable } from "tsyringe";
import { container } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

interface CreateActivityProps {
  type: string;
  action: string;
  entityId: string;
  description: string;
  status: string;
  performedBy: string;
  businessId: string | null;
  tenantName?: string | null;
  visibilityLevel?: string;
  performingUserRole?: string;
}

/**
 * Legacy façade over the notification pipeline.
 *
 * Only the audit-trail entry point remains: the dozens of use cases that call
 * `createActivityIfEnabled` ride the outbox through it without having been
 * edited. User-facing notifications no longer pass through here at all —
 * use cases publish their own topics via `OutboxService.publish` inside the
 * business transaction, and the pipeline's policies do the rest.
 */
@injectable()
class NotificationService {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
  ) {}

  async createActivityIfEnabled(
    activityData: CreateActivityProps,
  ): Promise<void> {
    try {
      const user = await this.userRepository.findUserById(
        activityData.performedBy,
      );

      if (!user) {
        return;
      }

      // Publishes the generic audit topic instead of writing the activity
      // inline. Every legacy call site rides the pipeline through this one
      // method — retried, idempotent per delivery — without being edited.
      // Hierarchical visibility is handled at query time in ActivityRepository.
      const { OutboxService } = await import(
        "@/shared/notifications/outbox-service"
      );

      const outbox =
        container.resolve<InstanceType<typeof OutboxService>>("OutboxService");

      await outbox.publishAfterCommit({
        topic: "activity.recorded",
        aggregateType: "activity",
        aggregateId: activityData.entityId,
        businessId: activityData.businessId,
        actorId: activityData.performedBy,
        payload: {
          type: activityData.type,
          action: activityData.action,
          entityId: activityData.entityId,
          description: activityData.description,
          status: activityData.status,
          tenantName: activityData.tenantName,
          visibilityLevel: activityData.visibilityLevel,
          performingUserRole: activityData.performingUserRole,
        },
      });
    } catch (error) {
      console.warn("Erro ao criar activity:", error);
    }
  }
}

export { NotificationService, CreateActivityProps };
