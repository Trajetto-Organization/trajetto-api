import { RegisterDeliveryProofUseCase } from "@/modules/delivery/usecases/register-delivery-proof/register-delivery-proof-usecase";
import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import type { IProofAuditRepository } from "@/modules/delivery/repositories/IProof-audit-repository";
import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";

/**
 * The installed app's proof route as the unit tests build it (decision 14.3):
 * the legacy adapter over the unified report, with the same nine services
 * the proof use case used to take, so a test's wiring reads as before. The
 * company's default delivered type is seeded on first use, as in production.
 */
function legacyProofUseCase(
  users: InMemoryUserRepository,
  deliveries: InMemoryDeliveryRepository,
  route: IRouteRepository,
  notification: NotificationService,
  outbox: OutboxService,
  audits: IProofAuditRepository,
  business: IBusinessRepository,
  upload: UploadService,
  webhooks: WebhookFanOutService,
  extras: {
    occurrenceTypes?: InMemoryOccurrenceTypeRepository;
    authorizations?: InMemoryOccurrenceAuthorizationRepository;
  } = {},
): RegisterDeliveryProofUseCase {
  const types = extras.occurrenceTypes ?? new InMemoryOccurrenceTypeRepository();
  const authorizations =
    extras.authorizations ??
    new InMemoryOccurrenceAuthorizationRepository(deliveries, types, users);

  const report = new ReportDeliveryOccurrenceUseCase(
    users,
    types,
    deliveries,
    route,
    notification,
    upload,
    outbox,
    webhooks,
    authorizations,
    audits,
    business,
  );

  return new RegisterDeliveryProofUseCase(users, types, report);
}

/** A business repository for tests that only need "no AI contracted". */
const businessWithoutAI = {
  findBusinessById: async (id: string) => ({ id, ai_analysis_limit: 0, timezone: "America/Sao_Paulo" }),
} as unknown as IBusinessRepository;

export { businessWithoutAI, legacyProofUseCase };
