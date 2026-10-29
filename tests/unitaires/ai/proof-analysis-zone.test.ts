import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyProofUseCase } from "../../support/delivery-proof-usecases";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";

import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { UploadService } from "@/shared/services/upload-service";

/**
 * The day a receipt is compared with is the carrier's (DLVP-PROOF-4).
 *
 * The proof asked for its reading without the company's zone, so the day
 * came out in São Paulo: for a carrier in Manaus, a receipt signed at 23:30
 * was compared with the NEXT day, and a correct receiving date read "wrong
 * date". Red on the old caller, which passed no timeZone.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-0000000000aa";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000ab";
const DRIVER = "018f0000-0000-7000-8000-0000000000ac";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a proof asking for its reading", () => {
  it("passes the company's zone, so a 23:30 receipt in Manaus is that day's", async () => {
    const deliveryRepository = new InMemoryDeliveryRepository();
    const routeRepository = new InMemoryRouteRepository(
      deliveryRepository.deliveries,
    );
    deliveryRepository.routeStops = routeRepository.stops;

    const users = new InMemoryUserRepository();
    users.user.push({
      id: DRIVER_USER,
      name: "João",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User);

    const created = await deliveryRepository.createDelivery({
      businessId: BUSINESS,
      shipperId: "018f0000-0000-7000-8000-0000000000ad",
      recipient_name: "Mercado Central",
      invoice_number: "45118",
      city: "Manaus",
      uf: "AM",
      street: "Rua das Entregas",
    } as CreateDeliveryProps);

    const delivery = deliveryRepository.deliveries.find(
      (entry) => entry.id === created.id,
    )!;
    delivery.status = "IN_TRANSIT";
    delivery.driverId = DRIVER;

    const business = {
      findBusinessById: async () => ({
        id: BUSINESS,
        ai_analysis_limit: 10,
        timezone: "America/Manaus",
      }),
    } as unknown as IBusinessRepository;

    const requestAnalysis = vi
      .spyOn(AIAnalysisService.getInstance(), "requestAnalysis")
      .mockResolvedValue("queued");

    const useCase = legacyProofUseCase(
      users,
      deliveryRepository,
      routeRepository,
      {
        createActivityIfEnabled: async () => undefined,
      } as unknown as NotificationService,
      { publish: async () => undefined } as unknown as OutboxService,
      new InMemoryProofAuditRepository(),
      business,
      {
        resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
          photos.map(({ key }) => ({ path: key })),
      } as unknown as UploadService,
      new InMemoryWebhookFanOutService().asService(),
    );

    // 30/09 23:30 in Manaus (UTC-4) is already 01/10 in São Paulo.
    await useCase.execute({
      userId: DRIVER_USER,
      businessId: BUSINESS,
      deliveryId: created.id!,
      client_submission_id: "018f0000-0000-7000-8000-0000000000ae",
      photo: "deliveryPhotos/canhoto.jpg",
      occurredAt: new Date("2026-10-01T03:30:00.000Z"),
    });

    expect(requestAnalysis).toHaveBeenCalledTimes(1);

    const [request] = requestAnalysis.mock.calls[0];

    expect(request.input).toMatchObject({
      photoPath: "deliveryPhotos/canhoto.jpg",
      provenOn: "2026-09-30",
      // The invoice, never the delivery's own code (decision 6.9).
      expectedDocument: "45118",
    });
  });
});
