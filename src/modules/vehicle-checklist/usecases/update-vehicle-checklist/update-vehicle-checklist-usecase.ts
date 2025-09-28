import { inject, injectable } from "tsyringe";
import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleMileageInvalidError } from "@/modules/fuel/usecases/errors/vehicle-mileage-invalid-error";

import { AppError } from "@/shared/errors/AppError";
import {
  VehicleChecklist,
  UpdateVehicleChecklistProps,
} from "../../dtos/vehicle-checklist-dto";

import { UploadService } from "@/shared/services/upload-service";
import { MultipartFile } from "@fastify/multipart";

import { PhotoValidationService } from "../../services/photo-validation-service";
import { RequiredPhotosMissingError } from "../errors/required-photos-missing-error";

@injectable()
class UpdateVehicleChecklistUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    checklistData: UpdateVehicleChecklistProps,
    userId: string,
    checklistId: string,
    businessId: string,
    checklistPhotoFiles?: MultipartFile[],
    photosByField?: { [key: string]: any },
    photosToRemove?: string[],
  ): Promise<VehicleChecklist> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Validate business exists
    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Validate checklist exists and belongs to business
    const findChecklist =
      await this.vehicleChecklist.getVehicleChecklistByIdAndBusiness({
        checklistId,
        businessId,
      });

    if (!findChecklist) {
      throw new AppError(
        "Checklist não encontrado ou não pertence a esta empresa.",
        404,
      );
    }

    // Validate photo requirements for any field changes
    // This prevents bypassing mandatory photo requirements by considering existing photos
    if (photosByField !== undefined && photosToRemove !== undefined) {
      const photoValidation =
        PhotoValidationService.validateRequiredPhotosForUpdate(
          checklistData,
          photosByField,
          findChecklist.photos || [],
          photosToRemove,
        );

      if (!photoValidation.isValid) {
        throw new RequiredPhotosMissingError(
          photoValidation.missingPhotos,
          photoValidation.errors,
          Object.keys(checklistData),
          Object.keys(photosByField),
          findChecklist.photos || [],
          photosToRemove,
        );
      }
    }

    // If updating vehicle, validate it exists and belongs to business
    if (checklistData.vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(
        checklistData.vehicleId,
      );

      if (!findVehicle) {
        throw new VehicleNotFoundError();
      }

      if (findVehicle.businessId !== businessId) {
        throw new VehicleNotBelongBusinessError();
      }

      // If updating mileage, validate it's not less than current vehicle mileage
      if (
        checklistData.current_mileage !== undefined &&
        checklistData.current_mileage < findVehicle.current_mileage
      ) {
        throw new VehicleMileageInvalidError();
      }
    }

    // If updating driver, validate it exists and belongs to business
    if (checklistData.driverId) {
      const findDriver = await this.driver.findDriverById(
        checklistData.driverId,
      );

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== businessId) {
        throw new DriverNotBelongBusinessError();
      }
    }

    // If updating branch, validate it exists and belongs to business
    if (checklistData.branchId) {
      const findBranch = await this.branch.findBranchById(
        checklistData.branchId,
      );

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    try {
      // Upload checklist photos if provided
      let newPhotoPaths: string[] = [];

      if (checklistPhotoFiles && checklistPhotoFiles.length > 0) {
        for (const photoFile of checklistPhotoFiles) {
          const buffer = await photoFile.toBuffer();
          const uploadResult = await this.uploadService.uploadFile({
            buffer,
            filename: photoFile.filename || "checklist-photo-update",
            mimetype: photoFile.mimetype,
            uploadType: "checklistPhotos",
          });
          newPhotoPaths.push(uploadResult.path);
        }
      }

      // Merge existing photos with new photos, considering photos to remove
      let finalPhotos: string[] = [];

      // Start with existing photos
      if (findChecklist.photos && findChecklist.photos.length > 0) {
        finalPhotos = [...findChecklist.photos];
      }

      // Remove photos that should be deleted
      if (photosToRemove && photosToRemove.length > 0) {
        // Convert URLs to relative paths for comparison and deletion
        const photoPathsToRemove = photosToRemove.map((photoUrl) => {
          if (photoUrl.includes("/tmp/")) {
            // Local: http://localhost:3333/tmp/checklistPhotos/file.webp -> checklistPhotos/file.webp
            return photoUrl.split("/tmp/")[1];
          } else if (photoUrl.includes("checklistPhotos/")) {
            // R2: https://domain.com/checklistPhotos/file.webp -> checklistPhotos/file.webp
            const startIndex = photoUrl.indexOf("checklistPhotos/");
            return photoUrl.substring(startIndex);
          }
          return photoUrl; // fallback if already relative
        });

        // Delete physical files from server/storage
        for (const photoPath of photoPathsToRemove) {
          try {
            await this.uploadService.deleteFile(photoPath);
          } catch (error) {
            console.error(
              `🔴 USECASE: Failed to delete photo file: ${photoPath}`,
              error,
            );
            // Continue with other deletions even if one fails
          }
        }

        // Remove from array using relative paths
        finalPhotos = finalPhotos.filter(
          (photo) => !photoPathsToRemove.includes(photo),
        );
      }

      // Add new photos
      if (newPhotoPaths.length > 0) {
        finalPhotos = [...finalPhotos, ...newPhotoPaths];
      }

      // Add photo paths to checklist data only if there are photos or if photos were modified
      const checklistDataWithPhotos =
        newPhotoPaths.length > 0 ||
        (photosToRemove && photosToRemove.length > 0)
          ? { ...checklistData, photos: finalPhotos }
          : checklistData;

      // Update the checklist
      const updatedChecklist =
        await this.vehicleChecklist.updateVehicleChecklist({
          checklistData: checklistDataWithPhotos,
          checklistId,
        });

      // Update vehicle mileage if current_mileage is being updated
      if (
        checklistData.current_mileage !== undefined &&
        checklistData.vehicleId
      ) {
        await this.vehicle.updateVehicle({
          vehicleId: checklistData.vehicleId,
          vehicleData: {
            current_mileage: checklistData.current_mileage,
          },
        });
      }

      // Get vehicle information for activity description
      const findVehicle = await this.vehicle.findVehicleById(
        updatedChecklist.vehicleId,
      );

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Checklist Veicular",
        action: "update",
        entityId: updatedChecklist.id,
        description: findVehicle
          ? `Checklist veicular atualizado para o veículo ${findVehicle.license_plate} - ${findVehicle.description}`
          : `Checklist veicular atualizado`,
        status: "Atualizado",
        performedBy: userId,
        businessId: businessId,
      });

      return updatedChecklist;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o checklist veicular! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateVehicleChecklistUseCase };
