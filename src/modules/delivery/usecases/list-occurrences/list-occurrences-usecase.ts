import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { UploadService } from "@/shared/services/upload-service";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { AppError } from "@/shared/errors/AppError";

import { ListOccurrencesResult } from "../../dtos/delivery-dto";

interface ListOccurrencesRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  blocksDelivery?: boolean;
  occurrenceTypeId?: string;
  search?: string;
}

/**
 * The manager's cross-delivery occurrence feed: every report of the
 * operation in one paginated table, with the photos already signed for
 * rendering. Drivers only ever see the occurrences of their own
 * deliveries — the same scoping rule the delivery list follows.
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
    blocksDelivery,
    occurrenceTypeId,
    search,
  }: ListOccurrencesRequest): Promise<
    ListOccurrencesResult & { counts: { total: number; blocking: number } }
  > {
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
      // The cards describe the operation, not the slice being looked at —
      // the counts deliberately ignore the page filters.
      const [result, counts] = await Promise.all([
        this.delivery.listOccurrences({
          page,
          pageSize,
          businessId: resolvedBusinessId,
          blocksDelivery,
          occurrenceTypeId,
          driverId: findUser.driverId ?? undefined,
          search,
        }),
        this.delivery.countOccurrencesSummary(
          resolvedBusinessId,
          findUser.driverId ?? undefined,
        ),
      ]);

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
        })),
      );

      return { ...result, data, counts };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Não foi possível recuperar as ocorrências!", 500);
    }
  }
}

export { ListOccurrencesUseCase };
