import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { UploadService } from "@/shared/services/upload-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
} from "../errors/delivery-errors";

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
      throw new ResourceNotFoundError();
    }

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    if (!findDelivery) {
      throw new DeliveryNotFoundError();
    }

    if (findDelivery.businessId !== businessId) {
      throw new DeliveryNotBelongBusinessError();
    }

    // Drivers only open deliveries assigned to them.
    if (findUser.driverId && findDelivery.driverId !== findUser.driverId) {
      throw new DeliveryNotFoundError();
    }

    const detail = (await this.delivery.findDeliveryDetailById(
      deliveryId,
    )) as
      | ({
          occurrences?: Array<
            { photos?: string[] } & Record<string, unknown>
          >;
          events?: Array<
            {
              photo?: string | null;
              signature?: string | null;
            } & Record<string, unknown>
          >;
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

    return { ...detail, occurrences, events };
  }
}

export { GetDeliveryUseCase };
