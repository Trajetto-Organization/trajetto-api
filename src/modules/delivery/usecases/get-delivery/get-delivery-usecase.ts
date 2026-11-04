import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import type { IExternalRecipientRepository } from "../../repositories/IExternal-recipient-repository";

import { UploadService } from "@/shared/services/upload-service";

import {
  buildDeliveryTimeline,
  type TimelineSources,
} from "@/shared/delivery/delivery-timeline";
import { DeliveryNotFoundError } from "../errors/delivery-errors";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { serializeMessageOptOut } from "@/shared/notifications/customer-message-suppression";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import {
  loadBusinessTimeZone,
  timeZoneOfBusiness,
  type BusinessLookup,
} from "@/shared/time/business-time-zone";

interface GetDeliveryRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
}

/** What GET /delivery/get-delivery answers: the detail and its meta. */
interface GetDeliveryAnswer {
  data: unknown;
  /** The company's zone the dialog prints its dates in (decision D22). */
  meta: { timeZone: string };
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
    // Contract C2 (03/11/2026): the opt-out state of the recipient. Optional
    // so callers built before it keep working; the container always
    // provides it.
    @inject("ExternalRecipientRepository")
    private recipients?: Pick<
      IExternalRecipientRepository,
      "messageOptOutState"
    >,
    // The company's zone for `meta.timeZone` (`read`). Optional for the same
    // reason; without it the zone is the platform's default.
    @inject("BusinessRepository")
    private business?: BusinessLookup,
  ) {}

  /**
   * The detail with the company's zone beside it, as the route detail and
   * the tower's tabs answer theirs (decision D22): the web's detail dialog
   * prints the opt-out dates (C2) on the company's clock, the browser's
   * only when an older API leaves the zone out. Read after the detail, so
   * a refused read never reaches the company row and the request holds one
   * connection at a time.
   */
  async read(request: GetDeliveryRequest): Promise<GetDeliveryAnswer> {
    const data = await this.execute(request);

    const timeZone = this.business
      ? await loadBusinessTimeZone(this.business, request.businessId)
      : timeZoneOfBusiness(null);

    return { data, meta: { timeZone } };
  }

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

    // Since when the recipient's phone and e-mail stopped receiving this
    // company's customer messages (C2); null on a channel that receives.
    const messageOptOut = serializeMessageOptOut(
      (await this.recipients?.messageOptOutState(businessId, deliveryId)) ??
        null,
    );

    return { ...detail, occurrences, events, timeline, messageOptOut };
  }
}

export { GetDeliveryUseCase };
export type { GetDeliveryAnswer, GetDeliveryRequest };
