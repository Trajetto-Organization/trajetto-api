import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { UploadService } from "@/shared/services/upload-service";

import {
  buildDeliveryTimeline,
  type TimelineSources,
} from "@/shared/delivery/delivery-timeline";
import { DeliveryNotFoundError } from "../errors/delivery-errors";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

interface GetDeliveryRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
}

@injectable()
class GetDeliveryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
  }: GetDeliveryRequest): Promise<unknown> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // Defense in depth: the route guard must not be the only wall between
    // tenants, as in the list and the exports of this module.
    assertTenantAccess(findUser, businessId);

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    // Another company's id reads as absent (decision 11.3): a separate
    // "not yours" answer told a caller which ids exist elsewhere.
    if (!findDelivery || findDelivery.businessId !== businessId) {
      throw new DeliveryNotFoundError();
    }

    // Drivers only open deliveries assigned to them.
    if (findUser.driverId && findDelivery.driverId !== findUser.driverId) {
      throw new DeliveryNotFoundError();
    }

    const detail = (await this.delivery.findDeliveryDetailById(deliveryId)) as
      | ({
          occurrences?: Array<{ photos?: string[] } & Record<string, unknown>>;
          events?: Array<
            {
              photo?: string | null;
              signature?: string | null;
            } & Record<string, unknown>
          >;
          chatMessages?: Array<{
            id: string;
            kind: string;
            body?: string | null;
            created_at: Date | string;
            sender?: { name: string } | null;
          }>;
        } & Record<string, unknown>)
      | null;

    if (!detail) {
      throw new DeliveryNotFoundError();
    }

    // Storage keys become short-lived signed URLs here, at read time: the
    // panel renders the images straight away and nothing permanent leaks
    // into the payload.
    const occurrences = await Promise.all(
      (detail.occurrences ?? []).map(async (occurrence) => ({
        ...occurrence,
        photos: await Promise.all(
          (occurrence.photos ?? []).map((key) =>
            this.uploadService.getFileUrl(key),
          ),
        ),
      })),
    );

    const events = await Promise.all(
      (detail.events ?? []).map(async (event) => ({
        ...event,
        photo: event.photo
          ? await this.uploadService.getFileUrl(event.photo)
          : null,
        signature: event.signature
          ? await this.uploadService.getFileUrl(event.signature)
          : null,
      })),
    );

    /**
     * The support timeline: everything that ever happened to this delivery,
     * in one list, newest first.
     *
     * Built from the same rows the panel already receives rather than from a
     * table of its own — an arrival, a typed occurrence and a message each
     * have an owner, and copying them into a timeline table would make two
     * writers for every one of them.
     *
     * Built AFTER the signing above, so a photo in the timeline is the same
     * short-lived URL the detail shows and not a storage key.
     */
    // Cast because `findDeliveryDetailById` returns `unknown` by contract:
    // the detail's shape evolves with the module, validated by zod at write
    // time and passed through on read. The builder's own types are what
    // actually constrain the merge, and they are tested directly.
    const timeline = buildDeliveryTimeline({
      events: events as unknown as TimelineSources["events"],
      occurrences: occurrences as unknown as TimelineSources["occurrences"],
      messages: detail.chatMessages as unknown as TimelineSources["messages"],
    });

    return { ...detail, occurrences, events, timeline };
  }
}

export { GetDeliveryUseCase };
