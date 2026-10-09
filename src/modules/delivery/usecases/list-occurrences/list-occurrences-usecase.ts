import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { UploadService } from "@/shared/services/upload-service";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { AppError } from "@/shared/errors/AppError";

import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import type { SortOrder } from "@/shared/pagination/list-query";

import {
  summarizeOccurrenceFeed,
  type OccurrenceFeedCategory,
  type OccurrenceFeedSearchMeta,
  type OccurrenceSeverity,
  type OccurrenceSortKey,
} from "./occurrence-feed";

interface ListOccurrencesRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  severity?: OccurrenceSeverity[];
  category?: OccurrenceFeedCategory[];
  occurrenceTypeIds?: string[];
  deliveryStatuses?: DeliveryStatus[];
  sort?: OccurrenceSortKey;
  order?: SortOrder;
}

interface ListOccurrencesResponse {
  data: unknown[];
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and filter options. */
  searchMeta: OccurrenceFeedSearchMeta;
}

/**
 * The manager's cross-delivery occurrence feed: every report of the
 * operation in one paginated table, with the photos already signed for
 * rendering. Sorting, filters and the cards are answered here over the whole
 * company, never over the page the screen holds (decision 8.8).
 *
 * Drivers are refused at the route (403 PERMISSION_DENIED: occurrence_manage
 * read is not in the driver permission map); the app reads occurrences
 * through the driver's own delivery routes.
 */
@injectable()
class ListOccurrencesUseCase {
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
    page,
    pageSize,
    search,
    severity,
    category,
    occurrenceTypeIds,
    deliveryStatuses,
    sort,
    order,
  }: ListOccurrencesRequest): Promise<ListOccurrencesResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // MASTER picks the company explicitly; everyone else is pinned to
    // their own — same resolution every list route in the app uses.
    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    try {
      const result = await this.delivery.listOccurrences({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        // Defence in depth only: the route never lets a driver token in. If
        // a future caller does, the feed still stops at their deliveries.
        driverId: findUser.driverId ?? undefined,
        search,
        severity,
        category,
        occurrenceTypeIds,
        deliveryStatuses,
      });

      const { total, searchMeta } = summarizeOccurrenceFeed(result.typeCounts, {
        severity,
        category,
        occurrenceTypeIds,
      });

      // Storage keys become short-lived signed URLs at read time — the
      // panel renders thumbnails straight away, same rule as the detail.
      const data = await Promise.all(
        (
          result.data as Array<{ photos?: string[] } & Record<string, unknown>>
        ).map(async (occurrence) => ({
          ...occurrence,
          photos: await Promise.all(
            (occurrence.photos ?? []).map((key) =>
              this.uploadService.getFileUrl(key),
            ),
          ),
          // Decision 14.3: a DELIVERED row's receipt and signature, signed
          // like the photos (null on a problem without them).
          receipt_photo: occurrence.receipt_photo
            ? await this.uploadService.getFileUrl(occurrence.receipt_photo as string)
            : null,
          signature: occurrence.signature
            ? await this.uploadService.getFileUrl(occurrence.signature as string)
            : null,
        })),
      );

      return { data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Não foi possível recuperar as ocorrências!", 500);
    }
  }
}

export { ListOccurrencesUseCase };
export type { ListOccurrencesRequest, ListOccurrencesResponse };
