import { inject, injectable } from "tsyringe";

import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { UploadService } from "@/shared/services/upload-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { VehicleChecklist } from "../../dtos/vehicle-checklist-dto";

import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import type { SortOrder } from "@/shared/pagination/list-query";

import {
  summarizeChecklistList,
  type ChecklistCondition,
  type ChecklistListSearchMeta,
  type ChecklistSortKey,
} from "./checklist-list";

interface ListVehicleChecklistRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  conditions?: ChecklistCondition[];
  branchIds?: string[];
  vehicleIds?: string[];
  sort?: ChecklistSortKey;
  order?: SortOrder;
}

interface ListVehicleChecklistResponse {
  data: VehicleChecklist[];
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and filter options. */
  searchMeta: ChecklistListSearchMeta;
}

/**
 * The checklists of ONE company, sorted, filtered and counted by the server
 * (decision 8.8). A driver token sees only their own checklists (decision
 * 4.4): the listing used to hand them every inspection of the company, with
 * the other drivers' names and CNH.
 */
@injectable()
class ListVehicleChecklistUseCase {
  constructor(
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  // `getFileUrl` signs asynchronously (AWS SDK v3), so each level waits for
  // its signatures before the object is assembled.
  private async signPhotosByField(
    value: VehicleChecklist["photos_by_field"],
  ): Promise<VehicleChecklist["photos_by_field"]> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    const signedEntries = await Promise.all(
      Object.entries(value).map(async ([fieldName, photoPaths]) => {
        if (!Array.isArray(photoPaths)) return [fieldName, []] as const;

        const signed = await Promise.all(
          photoPaths.map((photoPath) =>
            typeof photoPath === "string"
              ? this.uploadService.getFileUrl(photoPath)
              : Promise.resolve(photoPath),
          ),
        );

        return [fieldName, signed] as const;
      }),
    );

    return Object.fromEntries(signedEntries) as Record<string, string[]>;
  }

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    conditions,
    branchIds,
    vehicleIds,
    sort,
    order,
  }: ListVehicleChecklistRequest): Promise<ListVehicleChecklistResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

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
      const result = await this.vehicleChecklist.listVehicleChecklists({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        driverId: findUser.driverId ?? undefined,
        search,
        conditions,
        branchIds,
        vehicleIds,
      });

      const { total, searchMeta } = summarizeChecklistList(
        result.conditionCounts,
        result.branchCounts,
        result.vehicleCounts,
        { conditions },
      );

      const data = await Promise.all(
        result.data.map(async (checklist) => ({
          ...checklist,
          photos: checklist.photos
            ? await Promise.all(
                checklist.photos.map((photoPath: string) =>
                  this.uploadService.getFileUrl(photoPath),
                ),
              )
            : [],
          photos_by_field: await this.signPhotosByField(
            checklist.photos_by_field,
          ),
        })),
      );

      return { data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar os checklists veiculares! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListVehicleChecklistUseCase };
export type { ListVehicleChecklistRequest, ListVehicleChecklistResponse };
